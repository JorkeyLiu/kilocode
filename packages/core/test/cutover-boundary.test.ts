import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { deriveArchive } from "@opencode-ai/core/cutover/archive-path"
import { runCutover, bootstrapFreshDB, isFresh, bootstrapFreshStaged } from "@opencode-ai/core/cutover/cutover"
import { Database as BunDB } from "bun:sqlite"

async function makeDataRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-cutover-boundary-"))
  const cleanup = async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch {}
    try {
      const { parent, base } = deriveArchive(dir)
      await fs.rm(path.join(parent, `.cutover-${base}.marker.json`), { force: true }).catch(() => {})
      await fs.rm(path.join(parent, `.rollback-${base}.marker.json`), { force: true }).catch(() => {})
      await fs.rm(path.join(parent, `.kilo-${base}.lease.json`), { force: true }).catch(() => {})
      await fs.rm(path.join(parent, `${base}-archive`), { recursive: true, force: true }).catch(() => {})
    } catch {}
  }
  return { root: dir, cleanup }
}

async function ensureProject(root: string) {
  const dbPath = path.join(root, "kilo.db")
  const layer = Database.layerFromPath(dbPath)
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const existing = yield* db.get<{ id: string }>(sql`SELECT id FROM project WHERE id='proj_global'`).pipe(Effect.orDie)
      if (!existing) yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('proj_global', '/tmp', '[]', 1, 1)`).pipe(Effect.orDie)
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
  )
}

async function initLegacyDB(root: string) {
  await ensureProject(root)
  const dbPath = path.join(root, "kilo.db")
  const layer = Database.layerFromPath(dbPath)
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_legacy1', 'proj_global', 'legacy', '/tmp', 'Legacy', 'v1', 1, 1)`).pipe(Effect.orDie)
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
  )
  await fs.mkdir(path.join(root, "storage/session_diff"), { recursive: true })
  await fs.writeFile(path.join(root, "storage/session_diff", "ses_legacy1.json"), JSON.stringify({ diff: "x" }))
}

describe("cutover boundary - unconditional rerun guard and malformed fail-closed", () => {
  test("canonical nonempty rerun blocked at library (unconditional identity, not isFresh)", async () => {
    const { root, cleanup } = await makeDataRoot()
    try {
      await initLegacyDB(root)
      const first = await runCutover({ dataRoot: root })
      expect(first.archiveID).toMatch(/^\d{8}T\d{6}Z-/)
      expect(await isFresh(root)).toBe(true)
      // Make DB nonempty: add session and artifact, so isFresh becomes false but identity remains canonical
      await ensureProject(root)
      const dbPath = path.join(root, "kilo.db")
      const layer = Database.layerFromPath(dbPath)
      await Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_after', 'proj_global', 'after', '/tmp', 'After', 'v1', 99, 99)`).pipe(Effect.orDie)
        }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
      )
      await fs.writeFile(path.join(root, "storage/session_diff", "ses_after.json"), JSON.stringify({ diff: "y" }))
      expect(await isFresh(root)).toBe(false)
      // Rerun must still be blocked unconditionally because identity is canonical, even though zero-state fails
      let blocked = false
      try {
        await runCutover({ dataRoot: root })
      } catch (e) {
        blocked = true
        const msg = String((e as Error)?.message ?? e)
        expect(msg.includes("already active") || msg.includes("rerun blocked")).toBe(true)
      }
      expect(blocked).toBe(true)

      // bootstrapFreshDB must also be blocked on same canonical nonempty DB
      let blocked2 = false
      try {
        await bootstrapFreshDB(root, first.archiveID)
      } catch (e) {
        blocked2 = true
        const msg = String((e as Error)?.message ?? e)
        expect(msg.includes("already active")).toBe(true)
      }
      expect(blocked2).toBe(true)
    } finally {
      await cleanup()
    }
  })

  test("fail-closed malformed identity at library cutover", async () => {
    const { root, cleanup } = await makeDataRoot()
    try {
      await initLegacyDB(root)
      const first = await runCutover({ dataRoot: root })
      expect(first.archiveID).toBeTruthy()
      // Corrupt identity to malformed uuid
      const dbPath = path.join(root, "kilo.db")
      const db = new BunDB(dbPath)
      try {
        db.run("UPDATE storage_identity SET uuid = 'not-a-uuid' WHERE id = 1")
      } finally {
        db.close()
      }
      let failed = false
      try {
        await runCutover({ dataRoot: root })
      } catch (e) {
        failed = true
        expect(String(e).includes("invalid storage uuid")).toBe(true)
      }
      expect(failed).toBe(true)

      // also bootstrapFreshDB fail-closed on malformed
      let failed2 = false
      try {
        await bootstrapFreshDB(root, "20260101T000000Z-11111111-1111-1111-1111-111111111111")
      } catch (e) {
        failed2 = true
        expect(String(e).includes("invalid storage uuid")).toBe(true)
      }
      expect(failed2).toBe(true)

      // schema version mismatch malformed
      const db2 = new BunDB(dbPath)
      try {
        db2.run("UPDATE storage_identity SET uuid = '11111111-1111-1111-1111-111111111111', schema_version = '999' WHERE id = 1")
      } finally {
        db2.close()
      }
      let failed3 = false
      try {
        await runCutover({ dataRoot: root })
      } catch (e) {
        failed3 = true
        expect(String(e).includes("schema version")).toBe(true)
      }
      expect(failed3).toBe(true)
    } finally {
      await cleanup()
    }
  })

  test("bootstrapFreshStaged first-boot does not delete unexpected root files", async () => {
    const { root, cleanup } = await makeDataRoot()
    try {
      // No DB yet, root exists with an unrelated file that should survive fresh bootstrap
      await fs.mkdir(root, { recursive: true })
      const sentinel = path.join(root, "keep-me.txt")
      await fs.writeFile(sentinel, "do not delete")
      const siblingFile = path.join(path.dirname(root), "sibling-keep.txt")
      await fs.writeFile(siblingFile, "sibling")
      // fresh bootstrap via runCutover's first-boot path (internal-storage uses bootstrapFreshStaged, but we test library directly)
      // Use bootstrapFreshStaged on a fresh sibling directory to simulate first-boot
      const freshRoot = path.join(os.tmpdir(), `kilo-boundary-fresh-${Date.now()}-${Math.random().toString(16).slice(2)}`)
      await fs.mkdir(freshRoot, { recursive: true })
      const freshSentinel = path.join(freshRoot, "keep-me.txt")
      await fs.writeFile(freshSentinel, "do not delete")
      const freshID = "20260101T000000Z-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
      await bootstrapFreshStaged(freshRoot, freshID)
      // sentinel must still exist, not deleted
      expect(await fs.access(freshSentinel).then(() => true).catch(() => false)).toBe(true)
      expect(await fs.readFile(freshSentinel, "utf8")).toBe("do not delete")
      // sibling outside root must not have been deleted
      expect(await fs.access(siblingFile).then(() => true).catch(() => false)).toBe(true)
      // fresh DB should be canonical
      expect(await isFresh(freshRoot)).toBe(true)
      await fs.rm(freshRoot, { recursive: true, force: true })
      await fs.rm(siblingFile, { force: true }).catch(() => {})
    } finally {
      await cleanup()
    }
  })

  test("fresh no-DB bootstrap fail-closed when family artifact dirs nonempty — no identity/new DB, pre-existing intact", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-cutover-fresh-nonempty-"))
    const root = path.join(dir, "data")
    const cleanup = async () => {
      try {
        await fs.rm(dir, { recursive: true, force: true })
      } catch {}
      try {
        const { parent, base } = deriveArchive(root)
        await fs.rm(path.join(parent, `.cutover-${base}.marker.json`), { force: true }).catch(() => {})
        await fs.rm(path.join(parent, `.kilo-${base}.lease.json`), { force: true }).catch(() => {})
      } catch {}
    }
    try {
      await fs.mkdir(path.join(root, "storage", "session_diff"), { recursive: true })
      await fs.mkdir(path.join(root, "storage", "session_diff_base"), { recursive: true })
      await fs.mkdir(path.join(root, "storage", "session_share"), { recursive: true })
      // nonempty family dir: pre-existing artifact
      const pre = path.join(root, "storage", "session_diff", "pre-existing.json")
      await fs.writeFile(pre, JSON.stringify({ keep: 1 }))
      const sentinel = path.join(root, "keep-me.txt")
      await fs.writeFile(sentinel, "do not delete")
      const freshID = "20260101T000000Z-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
      // bootstrapFreshStaged must check family dirs empty BEFORE creating DB — fail closed without identity or new DB
      let threw = false
      try {
        await bootstrapFreshStaged(root, freshID)
      } catch (e) {
        threw = true
        expect(String((e as Error)?.message ?? e).includes("not empty")).toBe(true)
      }
      expect(threw).toBe(true)
      // no kilo.db should have been created (fail-before-identity)
      const dbExists = await fs.access(path.join(root, "kilo.db")).then(() => true).catch(() => false)
      expect(dbExists).toBe(false)
      // no canonical identity — isFresh must remain false
      expect(await isFresh(root)).toBe(false)
      // pre-existing file must remain intact
      expect(await fs.access(pre).then(() => true).catch(() => false)).toBe(true)
      expect(await fs.readFile(pre, "utf8")).toBe(JSON.stringify({ keep: 1 }))
      expect(await fs.readFile(sentinel, "utf8")).toBe("do not delete")
      // also bootstrapFreshDB (leased) must fail closed similarly without leaving DB/identity
      let threw2 = false
      try {
        await bootstrapFreshDB(root, "20260101T000000Z-bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee")
      } catch (e) {
        threw2 = true
        expect(String((e as Error)?.message ?? e).includes("not empty")).toBe(true)
      }
      expect(threw2).toBe(true)
      expect(await fs.access(path.join(root, "kilo.db")).then(() => true).catch(() => false)).toBe(false)
      expect(await isFresh(root)).toBe(false)
      expect(await fs.readFile(sentinel, "utf8")).toBe("do not delete")
      expect(await fs.access(pre).then(() => true).catch(() => false)).toBe(true)
    } finally {
      await cleanup()
    }
  })
})
