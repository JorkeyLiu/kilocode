import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { deriveArchive } from "@opencode-ai/core/cutover/archive-path"
import { leasePathFor } from "@opencode-ai/core/cutover/lease"
import { resolveCanonicalDbPath } from "../../src/private-worker/canonical-db-path"
import { resolveHiddenCliPath, resolveFullBinaryName } from "../../src/services/cli-backend/server-manager"

function repoRoot(): string {
  // from packages/kilo-vscode/tests/unit to repo root: ../../../..
  return resolve(import.meta.dirname, "../../../..")
}

function cliEntry(): string {
  return join(repoRoot(), "packages/opencode/src/index.ts")
}

function runHidden(op: string, dataRoot: string, extraArgs: string[] = [], env?: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const args = ["run", "--conditions=browser", cliEntry(), "__internal-storage-cutover", op, "--data-root", dataRoot, ...extraArgs]
  const res = spawnSync("bun", args, { encoding: "utf8", env: env ?? process.env })
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") }
}

function parseLastJson(stdout: string): Record<string, unknown> {
  const lines = stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]!) as Record<string, unknown>
      if (obj && obj.ok === true) return obj
    } catch {}
  }
  throw new Error(`no ok JSON in output: ${stdout.slice(0, 2000)}`)
}

async function makeLegacyRoot(): Promise<{ root: string; cleanup: () => void }> {
  const scratch = mkdtempSync(join(tmpdir(), "kilo-vscode-cutover-test-"))
  const root = join(scratch, "xdg-data", "kilo")
  mkdirSync(join(root, "storage", "session_diff"), { recursive: true })
  mkdirSync(join(root, "storage", "session_diff_base"), { recursive: true })
  mkdirSync(join(root, "storage", "session_share"), { recursive: true })
  const cleanup = () => {
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {}
    try {
      const { parent, base } = deriveArchive(root)
      rmSync(join(parent, `.cutover-${base}.marker.json`), { force: true })
      rmSync(join(parent, `.rollback-${base}.marker.json`), { force: true })
      rmSync(leasePathFor(root), { force: true })
    } catch {}
  }
  // create legacy DB with a session but no canonical identity row will be present? Database.layer creates schema but identity row is not inserted until cutover via bootstrapFreshStaged
  const dbPath = join(root, "kilo.db")
  const layer = Database.layerFromPath(dbPath)
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const existing = yield* db.get<{ id: string }>(sql`SELECT id FROM project WHERE id='proj_global'`).pipe(Effect.orDie)
      if (!existing) yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('proj_global', '/tmp', '[]', 1, 1)`).pipe(Effect.orDie)
      yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_legacy', 'proj_global', 'legacy', '/tmp', 'Legacy', 'v1', 1, 1)`).pipe(Effect.orDie)
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
  )
  // legacy artifacts
  writeFileSync(join(root, "storage/session_diff", "ses_legacy.json"), JSON.stringify({ diff: "x" }))
  return { root, cleanup }
}

describe("VS Code managed backend one-time canonical storage cutover (hidden CLI, Bun context)", () => {
  it("status is read-only identity existence, not isFresh zero-state: canonical true even with sessions", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "kilo-vscode-cutover-status-"))
    const root = join(scratch, "xdg-data", "kilo")
    mkdirSync(root, { recursive: true })
    try {
      // No DB -> status hasDb false, canonical false
      const before = runHidden("status", root)
      expect(before.status).toBe(0)
      const j0 = parseLastJson(before.stdout)
      expect(j0.hasDb).toBe(false)
      expect(j0.canonical).toBe(false)

      // Fresh bootstrap via cutover (no archive)
      const cut = runHidden("cutover", root)
      expect(cut.status).toBe(0)
      const cj = parseLastJson(cut.stdout)
      expect(cj.ok).toBe(true)
      expect(String(cj.archiveID)).toMatch(/^\d{8}T\d{6}Z-/)
      // No archive file should exist for fresh (archivePath empty)
      expect(cj.archivePath === "" || cj.fresh === true).toBe(true)

      // Now status should be canonical true (zero-state fresh)
      const st1 = runHidden("status", root)
      expect(st1.status).toBe(0)
      const j1 = parseLastJson(st1.stdout)
      expect(j1.hasDb).toBe(true)
      expect(j1.hasIdentity).toBe(true)
      expect(j1.canonical).toBe(true)

      // Rerun cutover should be blocked when already canonical and still zero-state (fresh canonical)
      const rerun = runHidden("cutover", root)
      expect(rerun.status).not.toBe(0)
      expect((rerun.stdout + rerun.stderr).includes("already active") || (rerun.stdout + rerun.stderr).includes("rerun blocked")).toBe(true)

      // Insert a session to prove status is not isFresh zero-state
      const dbPath = join(root, "kilo.db")
      const layer = Database.layerFromPath(dbPath)
      await Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const exists = yield* db.get<{ id: string }>(sql`SELECT id FROM project WHERE id='proj_global'`).pipe(Effect.orDie)
          if (!exists) yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('proj_global', '/tmp', '[]', 1, 1)`).pipe(Effect.orDie)
          yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_after', 'proj_global', 'after', '/tmp', 'After', 'v1', 99, 99)`).pipe(Effect.orDie)
        }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
      )
      writeFileSync(join(root, "storage/session_diff", "ses_after.json"), JSON.stringify({ diff: "y" }))

      // Status must still be canonical true even with sessions (read-only identity existence, not zero-state)
      const st2 = runHidden("status", root)
      expect(st2.status).toBe(0)
      const j2 = parseLastJson(st2.stdout)
      expect(j2.canonical).toBe(true)
      expect(j2.hasIdentity).toBe(true)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
      try {
        const { parent, base } = deriveArchive(root)
        rmSync(join(parent, `.cutover-${base}.marker.json`), { force: true })
        rmSync(leasePathFor(root), { force: true })
      } catch {}
    }
  }, 30000)

  it("legacy DB present: status canonical false, cutover archives legacy, retains archive, fresh canonical after", async () => {
    const { root, cleanup } = await makeLegacyRoot()
    try {
      const st = runHidden("status", root)
      expect(st.status).toBe(0)
      const j = parseLastJson(st.stdout)
      expect(j.hasDb).toBe(true)
      expect(j.canonical).toBe(false)

      const cut = runHidden("cutover", root)
      expect(cut.status).toBe(0)
      const cj = parseLastJson(cut.stdout)
      expect(cj.ok).toBe(true)
      const archivePath = String(cj.archivePath)
      expect(archivePath.length).toBeGreaterThan(0)
      expect(existsSync(archivePath)).toBe(true)
      expect(existsSync(join(archivePath, "manifest.json"))).toBe(true)
      expect(existsSync(join(archivePath, "kilo.db"))).toBe(true)
      // archive retained, not deleted
      expect(existsSync(join(root, "kilo.db"))).toBe(true)

      // After cutover, status canonical true
      const st2 = runHidden("status", root)
      expect(st2.status).toBe(0)
      const j2 = parseLastJson(st2.stdout)
      expect(j2.canonical).toBe(true)

      // Legacy session should not exist in fresh DB
      const dbPath = join(root, "kilo.db")
      const layer = Database.layerFromPath(dbPath)
      const rows = await Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          return yield* db.all<{ id: string }>(sql`SELECT id FROM session`).pipe(Effect.orDie)
        }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
      )
      expect(rows.some((r) => r.id === "ses_legacy")).toBe(false)

      // Legacy artifact archived, fresh storage empty
      expect(existsSync(join(root, "storage/session_diff", "ses_legacy.json"))).toBe(false)
      expect(existsSync(join(archivePath, "storage/session_diff", "ses_legacy.json"))).toBe(true)

      // Archive still present after cutover (retained)
      expect(existsSync(archivePath)).toBe(true)
      const { p4 } = deriveArchive(root)
      const archives = readdirSync(p4).filter((n) => !n.startsWith(".tmp-"))
      expect(archives.length).toBeGreaterThanOrEqual(1)
    } finally {
      cleanup()
    }
  }, 30000)

  it("fail closed on live competing lease", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "kilo-vscode-cutover-lease-"))
    const root = join(scratch, "xdg-data", "kilo")
    mkdirSync(root, { recursive: true })
    try {
      // create lease file with live PID (current process)
      const lp = leasePathFor(root)
      mkdirSync(dirname(lp), { recursive: true })
      writeFileSync(lp, JSON.stringify({ pid: process.pid, token: randomUUID(), createdAt: Date.now() }), "utf8")
      const st = runHidden("status", root)
      expect(st.status).not.toBe(0)
      expect((st.stdout + st.stderr).toLowerCase()).toContain("lease")
      // cutover should also fail closed on live lease
      const cut = runHidden("cutover", root)
      expect(cut.status).not.toBe(0)
      expect((cut.stdout + cut.stderr).toLowerCase()).toContain("lease")
    } finally {
      rmSync(scratch, { recursive: true, force: true })
      try {
        rmSync(leasePathFor(root), { force: true })
      } catch {}
    }
  }, 15000)

  it("fail closed on cutover/rollback markers", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "kilo-vscode-cutover-marker-"))
    const root = join(scratch, "xdg-data", "kilo")
    mkdirSync(root, { recursive: true })
    try {
      const { parent, base } = deriveArchive(root)
      const cutoverMarker = join(parent, `.cutover-${base}.marker.json`)
      const rollbackMarker = join(parent, `.rollback-${base}.marker.json`)
      mkdirSync(parent, { recursive: true })
      writeFileSync(cutoverMarker, JSON.stringify({ archiveID: "20260101T000000Z-11111111-1111-1111-1111-111111111111", stagedPath: join(parent, ".staged-kilo-foo"), dataRoot: root, phase: "staged" }))
      const st = runHidden("status", root)
      expect(st.status).not.toBe(0)
      expect((st.stdout + st.stderr).toLowerCase()).toContain("marker")
      rmSync(cutoverMarker, { force: true })
      writeFileSync(rollbackMarker, JSON.stringify({ archiveID: "20260101T000000Z-11111111-1111-1111-1111-111111111111", stagedPath: join(parent, ".rollback-staged-kilo-foo"), dataRoot: root }))
      const st2 = runHidden("status", root)
      expect(st2.status).not.toBe(0)
      expect((st2.stdout + st2.stderr).toLowerCase()).toContain("marker")
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 15000)

  it("resolveHiddenCliPath prefers serve when staged, falls back to full, and cross-platform packaged binary", () => {
    // In production, hidden prefers staged bin/kilo-serve when present (same artifact as serve), falls back to bin/kilo during transition.
    const base = mkdtempSync(join(tmpdir(), "kilo-hidden-resolve-"))
    try {
      const fakeExt = join(base, "ext")
      mkdirSync(join(fakeExt, "bin"), { recursive: true })
      // absent -> falls back to full
      expect(resolveHiddenCliPath(fakeExt)).toBe(join(fakeExt, "bin", resolveFullBinaryName()))
      // staged serve present -> prefers serve
      writeFileSync(join(fakeExt, "bin", "kilo-serve"), "serve")
      writeFileSync(join(fakeExt, "bin", "kilo"), "full")
      expect(resolveHiddenCliPath(fakeExt)).toBe(join(fakeExt, "bin", "kilo-serve"))
      // benchmark override still wins over staged
      const snap = join(base, "snap-kilo")
      writeFileSync(snap, "snap")
      expect(resolveHiddenCliPath(fakeExt, { KILO_P0_BACKEND_CLI: snap } as any)).toBe(snap)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
    // cross-platform names
    expect(resolveFullBinaryName("win32")).toBe("kilo.exe")
    expect(resolveFullBinaryName("darwin")).toBe("kilo")
  })

  it("uses owned temp XDG/DB fixtures, never actual user data", () => {
    const scratch = mkdtempSync(join(tmpdir(), "kilo-vscode-cutover-isolated-"))
    const root = join(scratch, "xdg-data", "kilo")
    mkdirSync(root, { recursive: true })
    try {
      const realData = resolveCanonicalDbPath({ env: process.env, homedir: homedir() })
      expect(resolve(root)).not.toBe(resolve(dirname(realData)))
      expect(root.startsWith(resolve(scratch))).toBe(true)
      // ensure runHidden with --data-root does not touch real HOME
      const st = runHidden("status", root)
      expect(st.status).toBe(0)
      const j = parseLastJson(st.stdout)
      expect(String(j.dataRoot)).toBe(resolve(root))
      expect(resolve(String(j.dataRoot)).startsWith(resolve(scratch))).toBe(true)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
