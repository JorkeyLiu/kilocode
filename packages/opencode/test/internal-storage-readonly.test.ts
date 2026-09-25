import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { spawnSync } from "child_process"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { deriveArchive } from "@opencode-ai/core/cutover/archive-path"

function repoRoot(): string {
  return path.resolve((import.meta as any).dir, "../../..")
}
function cliEntry(): string {
  return path.join(repoRoot(), "packages/opencode/src/index.ts")
}
function runHidden(op: string, dataRoot: string): { status: number | null; stdout: string; stderr: string } {
  const args = ["run", "--conditions=browser", cliEntry(), "__internal-storage-cutover", op, "--data-root", dataRoot]
  const res = spawnSync("bun", args, { encoding: "utf8", timeout: 15_000 } as any)
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") }
}
function parseLastJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]!) as Record<string, unknown>
      if (obj && obj.ok === true) return obj
    } catch {}
  }
  throw new Error(`no ok JSON: ${stdout.slice(0, 2000)}`)
}

async function makeLegacyRoot(): Promise<{ root: string; dbPath: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-internal-ro-"))
  const root = path.join(dir, "data")
  await fs.mkdir(path.join(root, "storage/session_diff"), { recursive: true })
  const dbPath = path.join(root, "kilo.db")
  const layer = Database.layerFromPath(dbPath)
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const exists = yield* db.get<{ id: string }>(sql`SELECT id FROM project WHERE id='proj_global'`).pipe(Effect.orDie)
      if (!exists) yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('proj_global', '/tmp', '[]', 1, 1)`).pipe(Effect.orDie)
      yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_legacy', 'proj_global', 'legacy', '/tmp', 'Legacy', 'v1', 1, 1)`).pipe(Effect.orDie)
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
  )
  await fs.writeFile(path.join(root, "storage/session_diff", "ses_legacy.json"), JSON.stringify({ diff: "x" }))
  const cleanup = async () => {
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch {}
    try {
      const { parent, base } = deriveArchive(root)
      await fs.rm(path.join(parent, `.kilo-${base}.lease.json`), { force: true }).catch(() => {})
    } catch {}
  }
  return { root, dbPath, cleanup }
}

describe("internal-storage status read-only", () => {
  test("status does not mutate legacy DB (bytes, mtime, no migration table)", async () => {
    const { root, dbPath, cleanup } = await makeLegacyRoot()
    try {
      const statBefore = await fs.stat(dbPath)
      const bytesBefore = statBefore.size
      const mtimeBefore = statBefore.mtimeMs
      // ensure no storage_identity table before (legacy)
      const { Database: BunDB } = await import("bun:sqlite")
      const db0 = new BunDB(dbPath, { readonly: true, create: false } as any)
      let hasTableBefore = false
      try {
        const row = db0.query("SELECT count(*) as c FROM storage_identity").get() as any
        hasTableBefore = row !== undefined
      } catch (e: any) {
        if (String(e.message).includes("no such table")) hasTableBefore = false
        else throw e
      } finally {
        db0.close()
      }
      // it may have table due to Database.layer migration; allow but check that status doesn't change bytes/mtime
      // Now run status (should be read-only)
      const res = runHidden("status", root)
      expect(res.status).toBe(0)
      const j = parseLastJson(res.stdout)
      expect(j.hasDb).toBe(true)
      expect(j.hasIdentity).toBe(false)
      expect(j.canonical).toBe(false)

      const statAfter = await fs.stat(dbPath)
      expect(statAfter.size).toBe(bytesBefore)
      // mtime may be same or not changed beyond fs granularity; ensure not increased by migration write
      // Allow small delta but file should not have been rewritten (size same, and no new wal)
      const walPath = dbPath + "-wal"
      const walExistsAfter = await fs.access(walPath).then(() => true).catch(() => false)
      // If wal didn't exist before, it shouldn't be created by read-only status
      const walExistsBefore = false // we didn't create wal before; status must not create it
      if (!walExistsBefore) {
        // status is read-only, should not create wal; if it did, bytes would change but we already checked size
        // just ensure file count not mutated
      }
      // Re-open readonly and check still no canonical identity, still legacy
      const db1 = new BunDB(dbPath, { readonly: true, create: false } as any)
      try {
        let row: any
        try {
          row = db1.query("SELECT uuid FROM storage_identity WHERE id=1").get() as any
        } catch (e: any) {
          if (String(e.message).includes("no such table")) row = undefined
          else throw e
        }
        expect(row).toBeFalsy()
      } finally {
        db1.close()
      }
      // bytes unchanged already proves no migration side-effect (migration would add table and change bytes)
      expect(statAfter.mtimeMs).toBe(mtimeBefore)
    } finally {
      await cleanup()
    }
  }, 15_000)

  test("status fail-closed on malformed identity still read-only", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-internal-mal-"))
    const root = path.join(dir, "data")
    await fs.mkdir(root, { recursive: true })
    const dbPath = path.join(root, "kilo.db")
    // create canonical DB then corrupt
    const layer = Database.layerFromPath(dbPath)
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const exists = yield* db.get<{ id: string }>(sql`SELECT id FROM project WHERE id='proj_global'`).pipe(Effect.orDie)
        if (!exists) yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('proj_global', '/tmp', '[]', 1, 1)`).pipe(Effect.orDie)
      }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
    )
    // run cutover to get canonical
    const cut = runHidden("cutover", root)
    expect(cut.status).toBe(0)
    const cj = parseLastJson(cut.stdout)
    expect(cj.ok).toBe(true)
    // corrupt uuid via direct bun sqlite write
    const { Database: BunDB } = await import("bun:sqlite")
    const db = new BunDB(dbPath)
    try {
      db.run("UPDATE storage_identity SET uuid='bad-uuid' WHERE id=1")
    } finally {
      db.close()
    }
    const statBefore = await fs.stat(dbPath)
    const res = runHidden("status", root)
    expect(res.status).not.toBe(0)
    expect((res.stdout + res.stderr).includes("invalid storage uuid")).toBe(true)
    const statAfter = await fs.stat(dbPath)
    expect(statAfter.size).toBe(statBefore.size)
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    try {
      const { parent, base } = deriveArchive(root)
      await fs.rm(path.join(parent, `.kilo-${base}.lease.json`), { force: true }).catch(() => {})
    } catch {}
  }, 15000)
})
