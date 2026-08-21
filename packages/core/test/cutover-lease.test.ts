import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { acquireLease, leasePathFor, _clearForTests } from "@opencode-ai/core/cutover/lease"

async function mkRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-lease-"))
  const cleanup = async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch {}
    try {
      const parent = path.dirname(path.resolve(dir))
      const base = path.basename(path.resolve(dir))
      await fs.rm(path.join(parent, `.kilo-${base}.lease.json`), { force: true }).catch(() => {})
      await fs.rm(path.join(parent, `.cutover-${base}.marker.json`), { force: true }).catch(() => {})
      await fs.rm(path.join(parent, `.rollback-${base}.marker.json`), { force: true }).catch(() => {})
    } catch {}
  }
  return { root: dir, cleanup }
}

describe("cross-process data-root lease", () => {
  afterEach(() => _clearForTests())

  test("stale PID lease is recovered and acquired", async () => {
    const { root, cleanup } = await mkRoot()
    try {
      const lp = leasePathFor(root)
      await fs.mkdir(path.dirname(lp), { recursive: true }).catch(() => {})
      await fs.writeFile(lp, JSON.stringify({ pid: 999999, token: "dead", createdAt: Date.now() }), "utf8")
      const handle = await acquireLease(root)
      expect(handle.pid).toBe(process.pid)
      expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(true)
      await handle.release()
      expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(false)
    } finally {
      await cleanup()
    }
  })

  test("live PID lease is refused (exclusivity cannot be proven)", async () => {
    const { root, cleanup } = await mkRoot()
    try {
      const lp = leasePathFor(root)
      await fs.mkdir(path.dirname(lp), { recursive: true }).catch(() => {})
      // live PID = this process, foreign token -> cross-process holder
      await fs.writeFile(lp, JSON.stringify({ pid: process.pid, token: "foreign", createdAt: Date.now() }), "utf8")
      let failed = false
      try {
        await acquireLease(root)
      } catch (e) {
        failed = true
        expect(String(e).includes("live") || String(e).includes("held") || String(e).includes("exclusivity")).toBe(true)
      }
      expect(failed).toBe(true)
      // cleanup the simulated holder
      await fs.rm(lp, { force: true })
    } finally {
      await cleanup()
    }
  })

  test("concurrent acquisition after release succeeds", async () => {
    const { root, cleanup } = await mkRoot()
    try {
      const h1 = await acquireLease(root)
      await h1.release()
      const h2 = await acquireLease(root)
      expect(h2.pid).toBe(process.pid)
      await h2.release()
    } finally {
      await cleanup()
    }
  })
})

describe("same-process reentrant lease (F2)", () => {
  afterEach(() => _clearForTests())

  test("nested acquire refcounts and final release only at zero", async () => {
    const { root, cleanup } = await mkRoot()
    try {
      const lp = leasePathFor(root)
      const outer = await acquireLease(root)
      expect(outer.pid).toBe(process.pid)
      expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(true)
      const inner = await acquireLease(root)
      // same owner token, reentrant
      expect(inner.token).toBe(outer.token)
      expect(inner.pid).toBe(process.pid)
      // release inner: refcount drops but file stays (still held)
      await inner.release()
      expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(true)
      // release outer: refcount zero -> file removed
      await outer.release()
      expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(false)
    } finally {
      await cleanup()
    }
  })

  test("non-owner release is protected after final release", async () => {
    const { root, cleanup } = await mkRoot()
    try {
      const handle = await acquireLease(root)
      await handle.release()
      // a second release attempt hits a removed owner entry and must throw
      let failed = false
      try {
        await handle.release()
      } catch (e) {
        failed = true
        expect(String(e).includes("non-owner")).toBe(true)
      }
      expect(failed).toBe(true)
    } finally {
      await cleanup()
    }
  })

  test("nested layers across file-backed scopes share one lease and release cleanly", async () => {
    const { root, cleanup } = await mkRoot()
    try {
      const lp = leasePathFor(root)
      const { Database } = await import("@opencode-ai/core/database/database")
      const { Effect } = await import("effect")
      const dbPath = path.join(root, "kilo.db")
      const layerA = Database.layerFromPath(dbPath)
      const layerB = Database.layerFromPath(dbPath)
      // both file-backed layers on the same data root alive simultaneously (reentrant)
      await Effect.runPromise(
        Effect.gen(function* () {
          const a = yield* Database.Service
          yield* a.db.run(`SELECT 1`).pipe(Effect.orDie)
          yield* Effect.scoped(
            Effect.gen(function* () {
              const b = yield* Database.Service
              yield* b.db.run(`SELECT 1`).pipe(Effect.orDie)
              const held = yield* Effect.promise(() => fs.access(lp).then(() => true).catch(() => false))
              expect(held).toBe(true)
            }).pipe(Effect.provide(layerB)),
          )
          // outer layerA still open -> lease still held
          const heldOuter = yield* Effect.promise(() => fs.access(lp).then(() => true).catch(() => false))
          expect(heldOuter).toBe(true)
        }).pipe(Effect.provide(layerA)),
      )
      // both scopes closed -> lease released
      expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(false)
    } finally {
      await cleanup()
    }
  })
})

describe("concurrent same-process serialization", () => {
  afterEach(() => _clearForTests())

  test("concurrent same-path acquisition serializes and refcounts", async () => {
    const { root, cleanup } = await mkRoot()
    try {
      const lp = leasePathFor(root)
      const [h1, h2, h3] = await Promise.all([acquireLease(root), acquireLease(root), acquireLease(root)])
      expect(h1.token).toBe(h2.token)
      expect(h2.token).toBe(h3.token)
      expect(h1.pid).toBe(process.pid)
      expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(true)
      // refcount 3: two releases keep file
      await h1.release()
      expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(true)
      await h2.release()
      expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(true)
      await h3.release()
      expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(false)
    } finally {
      await cleanup()
    }
  })

  test("concurrent different-path acquisitions do not block each other", async () => {
    const { root: rootA, cleanup: cleanupA } = await mkRoot()
    const { root: rootB, cleanup: cleanupB } = await mkRoot()
    try {
      const lpA = leasePathFor(rootA)
      const lpB = leasePathFor(rootB)
      const [hA, hB] = await Promise.all([acquireLease(rootA), acquireLease(rootB)])
      expect(hA.token).not.toBe(hB.token)
      expect(await fs.access(lpA).then(() => true).catch(() => false)).toBe(true)
      expect(await fs.access(lpB).then(() => true).catch(() => false)).toBe(true)
      await Promise.all([hA.release(), hB.release()])
      expect(await fs.access(lpA).then(() => true).catch(() => false)).toBe(false)
      expect(await fs.access(lpB).then(() => true).catch(() => false)).toBe(false)
    } finally {
      await cleanupA()
      await cleanupB()
    }
  })

  test("mixed concurrent plus nested reentrancy refcounts correctly", async () => {
    const { root, cleanup } = await mkRoot()
    try {
      const lp = leasePathFor(root)
      const [h1, h2] = await Promise.all([acquireLease(root), acquireLease(root)])
      expect(h1.token).toBe(h2.token)
      const h3 = await acquireLease(root)
      expect(h3.token).toBe(h1.token)
      expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(true)
      await h3.release()
      expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(true)
      await h1.release()
      expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(true)
      await h2.release()
      expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(false)
      // stale chain cleaned: next acquire should create fresh token
      const h4 = await acquireLease(root)
      expect(h4.token).not.toBe(h1.token)
      await h4.release()
      expect(await fs.access(lp).then(() => true).catch(() => false)).toBe(false)
    } finally {
      await cleanup()
    }
  })
})
