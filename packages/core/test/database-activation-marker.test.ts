import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database, markerPathsForFile, assertNoActivationMarker } from "@opencode-ai/core/database/database"
import { deriveArchive } from "@opencode-ai/core/cutover/archive-path"
import { leasePathFor, _clearForTests } from "@opencode-ai/core/cutover/lease"

async function mkRoot(): Promise<{ root: string; dbPath: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-db-marker-"))
  const dbPath = path.join(dir, "kilo.db")
  const cleanup = async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch {}
    try {
      const { parent, base } = deriveArchive(dir)
      await fs.rm(path.join(parent, `.cutover-${base}.marker.json`), { force: true })
      await fs.rm(path.join(parent, `.rollback-${base}.marker.json`), { force: true })
      await fs.rm(path.join(parent, `.kilo-${base}.lease.json`), { force: true })
    } catch {}
    _clearForTests()
  }
  return { root: dir, dbPath, cleanup }
}

describe("database activation marker gate (shared)", () => {
  test("markerPathsForFile shares deriveArchive with cutover/rollback (dataRoot parent sibling)", async () => {
    const { root, dbPath } = await mkRoot()
    const derived = deriveArchive(root)
    const got = markerPathsForFile(dbPath)!
    expect(got.cutover).toBe(path.join(derived.parent, `.cutover-${derived.base}.marker.json`))
    expect(got.rollback).toBe(path.join(derived.parent, `.rollback-${derived.base}.marker.json`))
    expect(markerPathsForFile(":memory:")).toBeUndefined()
    expect(markerPathsForFile(":memory:foo")).toBeUndefined()
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    _clearForTests()
  })

  test("assertNoActivationMarker blocks on cutover marker, passes after removal", async () => {
    const { root, dbPath, cleanup } = await mkRoot()
    try {
      const { parent, base } = deriveArchive(root)
      const cutover = path.join(parent, `.cutover-${base}.marker.json`)
      await fs.writeFile(
        cutover,
        JSON.stringify({ archiveID: "20260101T000000Z-00000000-0000-0000-0000-000000000000" }),
        "utf8",
      )
      let failed = false
      try {
        await assertNoActivationMarker(dbPath)
      } catch (e) {
        failed = true
        expect(String(e)).toContain("DB activation blocked")
        expect(String(e)).toContain(cutover)
        expect(String(e)).toContain("marker exists")
      }
      expect(failed).toBe(true)
      await fs.rm(cutover, { force: true })
      await assertNoActivationMarker(dbPath)
      // :memory: never blocks
      await assertNoActivationMarker(":memory:")
    } finally {
      await cleanup()
    }
  })

  test("assertNoActivationMarker blocks on rollback marker", async () => {
    const { root, dbPath, cleanup } = await mkRoot()
    try {
      const { parent, base } = deriveArchive(root)
      const rollback = path.join(parent, `.rollback-${base}.marker.json`)
      await fs.writeFile(rollback, "{}", "utf8")
      let failed = false
      try {
        await assertNoActivationMarker(dbPath)
      } catch (e) {
        failed = true
        expect(String(e)).toContain("DB activation blocked")
        expect(String(e)).toContain(rollback)
      }
      expect(failed).toBe(true)
      await fs.rm(rollback, { force: true })
      await assertNoActivationMarker(dbPath)
    } finally {
      await cleanup()
    }
  })

  test("writer activation (layerFromPath) fail-closed on cutover marker", async () => {
    const { root, dbPath, cleanup } = await mkRoot()
    try {
      const { parent, base } = deriveArchive(root)
      const cutover = path.join(parent, `.cutover-${base}.marker.json`)
      await fs.writeFile(cutover, "{}", "utf8")
      const layer = Database.layerFromPath(dbPath)
      let failed = false
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const svc = yield* Database.Service
            yield* svc.db.get(sql`SELECT 1`)
          }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
        )
      } catch (e) {
        failed = true
        expect(String(e)).toContain("marker exists")
        expect(String(e)).toContain(cutover)
      }
      expect(failed).toBe(true)
      // lease must not be leaked on failure
      const lp = leasePathFor(root)
      expect(
        await fs
          .access(lp)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
      await fs.rm(cutover, { force: true })
      // after removal writer succeeds
      const layer2 = Database.layerFromPath(dbPath)
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* Database.Service
          const row = yield* svc.db.get(sql`SELECT 1 as one`).pipe(Effect.orDie)
          expect((row as any).one).toBe(1)
        }).pipe(Effect.provide(layer2), Effect.scoped, Effect.orDie),
      )
    } finally {
      await cleanup()
    }
  })

  test("writer activation fail-closed on rollback marker", async () => {
    const { root, dbPath, cleanup } = await mkRoot()
    try {
      const { parent, base } = deriveArchive(root)
      const rollback = path.join(parent, `.rollback-${base}.marker.json`)
      await fs.writeFile(rollback, "{}", "utf8")
      const layer = Database.layerFromPath(dbPath)
      let failed = false
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const svc = yield* Database.Service
            yield* svc.db.get(sql`SELECT 1`)
          }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
        )
      } catch (e) {
        failed = true
        expect(String(e)).toContain("marker exists")
        expect(String(e)).toContain(rollback)
      }
      expect(failed).toBe(true)
      const lp = leasePathFor(root)
      expect(
        await fs
          .access(lp)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
      await fs.rm(rollback, { force: true })
      const layer2 = Database.layerFromPath(dbPath)
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* Database.Service
          const row = yield* svc.db.get(sql`SELECT 1 as one`).pipe(Effect.orDie)
          expect((row as any).one).toBe(1)
        }).pipe(Effect.provide(layer2), Effect.scoped, Effect.orDie),
      )
    } finally {
      await cleanup()
    }
  })

  test("no marker: writer and assert succeed (normal pure observation path)", async () => {
    const { root, dbPath, cleanup } = await mkRoot()
    try {
      await assertNoActivationMarker(dbPath)
      const layer = Database.layerFromPath(dbPath)
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* Database.Service
          yield* svc.db.get(sql`SELECT 1 as one`).pipe(Effect.orDie)
        }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
      )
      // layerNoLease pure observer also succeeds without lease
      const noLease = Database.layerNoLease(dbPath)
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* Database.Service
          yield* svc.db.get(sql`SELECT 1 as one`).pipe(Effect.orDie)
        }).pipe(Effect.provide(noLease), Effect.scoped, Effect.orDie),
      )
      const lp = leasePathFor(root)
      // noLease must never have created lease; but layerFromPath already released after scope
      expect(
        await fs
          .access(lp)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    } finally {
      await cleanup()
    }
  })
})
