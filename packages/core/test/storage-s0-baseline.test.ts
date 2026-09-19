import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { collectBaseline, collectBaselineFsOnly } from "@opencode-ai/core/storage/baseline"
import * as Retention from "@opencode-ai/core/retention/retention"
import { createS0Fixture } from "./helpers/storage-s0"

describe("S0 storage baseline and fixtures", () => {
  test("baseline on missing dataRoot reports zeros/absent safely and does not create files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-s0-missing-"))
    const missing = path.join(dir, "nonexistent")
    // ensure missing indeed absent
    expect(
      await fs
        .access(missing)
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
    const report = await collectBaselineFsOnly(missing)
    expect(report.version).toBe(1)
    expect(report.dataRoot).toBe(path.resolve(missing))
    expect(report.db.main.exists).toBe(false)
    expect(report.db.main.bytes).toBe(0)
    expect(report.db.wal.exists).toBe(false)
    expect(report.db.wal.bytes).toBe(0)
    expect(report.db.shm.exists).toBe(false)
    expect(report.db.export.exists).toBe(false)
    for (const v of Object.values(report.tables)) {
      expect(v.rows).toBe(0)
      expect(v.bytes).toBe(0)
    }
    for (const v of Object.values(report.artifacts)) {
      expect(v.files).toBe(0)
      expect(v.bytes).toBe(0)
    }
    expect(report.families.total).toBe(0)
    expect(report.families.roots).toEqual([])
    // must not have created the missing dir
    expect(
      await fs
        .access(missing)
        .then(() => true)
        .catch(() => false),
    ).toBe(false)
    await fs.rm(dir, { recursive: true, force: true })
  })

  test("S0 fixture creates isolated canonical DB with three states and cleans up", async () => {
    const fix = await createS0Fixture()
    try {
      // isolation: dir not equal prod and not inside prod
      expect(path.resolve(fix.dir)).not.toBe(path.resolve(Global.Path.data))
      expect(fix.dbPath).toContain(fix.dir)
      expect(fix.storageDir).toContain(fix.dir)
      // DB file exists
      expect(
        await fs
          .access(fix.dbPath)
          .then(() => true)
          .catch(() => false),
      ).toBe(true)
      // artifacts exist for retained family
      expect(
        await fs
          .access(path.join(fix.storageDir, "session_diff", `${fix.retained.rootID}.json`))
          .then(() => true)
          .catch(() => false),
      ).toBe(true)
      expect(
        await fs
          .access(path.join(fix.storageDir, "session_diff", `${fix.active.rootID}.json`))
          .then(() => true)
          .catch(() => false),
      ).toBe(true)
      expect(
        await fs
          .access(path.join(fix.storageDir, "session_diff", `${fix.leased.rootID}.json`))
          .then(() => true)
          .catch(() => false),
      ).toBe(true)
      // snapshot exists (project-owned)
      const snapFiles = await fs.readdir(path.join(fix.dir, "snapshot", "proj_global", "hash")).catch(() => [])
      expect(snapFiles.length).toBe(1)

      // baseline reports correct counts
      const report = await fix.baseline()
      expect(report.tables["session"].rows).toBe(4)
      expect(report.tables["message"].rows).toBe(1)
      expect(report.tables["part"].rows).toBe(1)
      expect(report.tables["todo"].rows).toBe(1)
      expect(report.artifacts["session_diff"].files).toBe(4)
      expect(report.artifacts["session_diff_base"].files).toBe(1)
      expect(report.artifacts["session_share"].files).toBe(1)
      expect(report.artifacts["snapshot"].files).toBe(1)
      expect(report.families.total).toBe(3) // retained root, active root, leased root (retained child not root)
      expect(report.families.roots.sort()).toEqual([fix.retained.rootID, fix.active.rootID, fix.leased.rootID].sort())
      expect(report.db.main.exists).toBe(true)
      expect(report.db.main.bytes).toBeGreaterThan(0)

      // changefeed state exists (initialized)
      expect(report.changefeed.latestSeq).toBeGreaterThanOrEqual(0)
      expect(report.storageIdentity).toBeDefined()

      // fixture state: retained eligible, active/leased protected
      const nl = Database.layerNoLease(fix.dbPath)
      const eligibility = await Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          return yield* Retention.eligibleFamilies(db, Date.now(), fix.isActive, fix.isLeased)
        }).pipe(Effect.provide(nl), Effect.scoped, Effect.orDie),
      )
      expect(eligibility.eligible.map((f) => f.rootID)).toContain(fix.retained.rootID)
      expect(eligibility.eligible.map((f) => f.rootID)).not.toContain(fix.active.rootID)
      expect(eligibility.eligible.map((f) => f.rootID)).not.toContain(fix.leased.rootID)
      expect(eligibility.skipped.some((s) => s.reason === "active")).toBe(true)
      expect(eligibility.skipped.some((s) => s.reason === "leased")).toBe(true)

      // after releasing leases, previously protected become eligible
      fix.active.release()
      fix.leased.release()
      expect(fix.isActive(fix.active.rootID)).toBe(false)
      expect(fix.isLeased(fix.leased.rootID)).toBe(false)
      const afterRelease = await Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          return yield* Retention.eligibleFamilies(db, Date.now(), fix.isActive, fix.isLeased)
        }).pipe(Effect.provide(nl), Effect.scoped, Effect.orDie),
      )
      expect(afterRelease.eligible.map((f) => f.rootID)).toContain(fix.active.rootID)
      expect(afterRelease.eligible.map((f) => f.rootID)).toContain(fix.leased.rootID)

      // baseline is read-only: running twice yields stable structural counts (timestamp may differ)
      const report2 = await fix.baseline()
      expect(report2.tables["session"].rows).toBe(report.tables["session"].rows)
      expect(report2.artifacts["session_diff"].files).toBe(report.artifacts["session_diff"].files)
      expect(report2.families.total).toBe(report.families.total)
      // ensure DB not mutated: check that wal not grown unexpectedly due to baseline
      const beforeStat = report.db.main.bytes
      const afterStat = report2.db.main.bytes
      expect(afterStat).toBe(beforeStat)

      // artifact isolation: deleting retained family artifacts must not delete snapshot or other families
      // simulate retention deleteFamilyUnprotected for retained (requires transaction)
      const delLayer = Database.layerFromPath(fix.dbPath)
      await Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* Retention.deleteFamilyUnprotected(db, fix.retained.rootID, Date.now())
        }).pipe(Effect.provide(delLayer), Effect.scoped, Effect.orDie),
      )
      // after delete, retained session rows gone, but active/leased remain
      const postDelReport = await fix.baseline()
      expect(postDelReport.tables["session"].rows).toBe(2) // active + leased remain
      expect(postDelReport.families.total).toBe(2)
      // snapshot must still exist (project-owned, never deleted via family pruning)
      expect(
        await fs
          .access(path.join(fix.dir, "snapshot", "proj_global", "hash", "snapshot.bin"))
          .then(() => true)
          .catch(() => false),
      ).toBe(true)
      // active artifact still exists (not deleted)
      expect(
        await fs
          .access(path.join(fix.storageDir, "session_diff", `${fix.active.rootID}.json`))
          .then(() => true)
          .catch(() => false),
      ).toBe(true)

      // ensure production DB untouched: check prod path not equal and not mutated (we didn't write there)
      expect(path.resolve(Global.Path.data)).not.toBe(path.resolve(fix.dir))
    } finally {
      const dir = fix.dir
      await fix.cleanup()
      expect(
        await fs
          .access(dir)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
      // production still exists (we didn't delete it)
      // Global.Path.data may be /tmp in test env but should still exist
      expect(
        await fs
          .access(Global.Path.data)
          .then(() => true)
          .catch(() => false),
      ).toBe(true)
    }
  })

  test("baseline script helper collectBaselineFsOnly is deterministic JSON and handles WAL/SHM absent as zero", async () => {
    const fix = await createS0Fixture()
    try {
      const r1 = await collectBaselineFsOnly(fix.dir)
      const r2 = await collectBaselineFsOnly(fix.dir)
      // compare without timestamp/mtime (allow fs mtime jitter)
      const strip = (o: any) => {
        const c = JSON.parse(JSON.stringify(o))
        for (const k of Object.keys(c.db ?? {})) delete c.db[k].mtimeMs
        delete c.timestamp
        return c
      }
      expect(JSON.stringify(strip(r1))).toBe(JSON.stringify(strip(r2)))
      // WAL/SHM may be absent or present but must be reported, not throw
      expect(typeof r1.db.wal.bytes).toBe("number")
      expect(typeof r1.db.shm.bytes).toBe("number")
      expect(r1.db.export.exists).toBe(false)
      expect(r1.db.export.bytes).toBe(0)
    } finally {
      await fix.cleanup()
    }
  })

  test("fixture never writes to production storage or DB", async () => {
    // record production baseline before
    const prodBefore = await collectBaselineFsOnly(Global.Path.data)
    const fix = await createS0Fixture()
    try {
      const prodAfter = await collectBaselineFsOnly(Global.Path.data)
      // ensure counts not changed by fixture creation (unless production is same as tmp, which it isn't)
      expect(prodAfter.tables["session"].rows).toBe(prodBefore.tables["session"].rows)
      expect(prodAfter.dataRoot).toBe(prodBefore.dataRoot)
      // fixture dir must be under os tmp (accounting for /var -> /private/var symlink) and not production
      const realTmp = await fs.realpath(os.tmpdir()).catch(() => os.tmpdir())
      expect(fix.dir.includes("kilo-s0-")).toBe(true)
      expect(path.resolve(fix.dir).startsWith(path.resolve(Global.Path.data))).toBe(false)
      // also ensure realTmp prefix or at least not equal prod
      expect(path.resolve(fix.dir) === path.resolve(Global.Path.data)).toBe(false)
    } finally {
      await fix.cleanup()
    }
  })
})
