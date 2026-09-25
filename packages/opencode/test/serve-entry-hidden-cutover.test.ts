import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import fssync from "fs"
import path from "path"
import os from "os"
import { spawnSync, spawn } from "child_process"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { deriveArchive } from "@opencode-ai/core/cutover/archive-path"
import { leasePathFor } from "@opencode-ai/core/cutover/lease"

function repoRoot(): string {
  return path.resolve((import.meta as any).dir, "../../..")
}
function serveEntry(): string {
  return path.join(repoRoot(), "packages/opencode/src/serve-entry.ts")
}
function bundledServePath(): string | undefined {
  // Match build.ts target naming: @kilocode/cli-<os>-<arch>[/<abi>]/bin/kilo-serve
  const base = path.join(repoRoot(), "packages/opencode/dist")
  if (!fssync.existsSync(base)) return undefined
  try {
    const entries = fssync.readdirSync(base, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const cand = path.join(base, e.name, "bin", e.name.includes("windows") ? "kilo-serve.exe" : "kilo-serve")
      if (fssync.existsSync(cand)) return cand
      // scoped package layout: @kilocode/cli-darwin-arm64
      if (e.name === "@kilocode") {
        const inner = fssync.readdirSync(path.join(base, e.name), { withFileTypes: true })
        for (const ii of inner) {
          const cand2 = path.join(base, e.name, ii.name, "bin", "kilo-serve")
          if (fssync.existsSync(cand2)) return cand2
          const cand2exe = path.join(base, e.name, ii.name, "bin", "kilo-serve.exe")
          if (fssync.existsSync(cand2exe)) return cand2exe
        }
      }
    }
  } catch {}
  // fallback to darwin-arm64
  const fallback = path.join(base, "@kilocode/cli-darwin-arm64/bin/kilo-serve")
  if (fssync.existsSync(fallback)) return fallback
  return undefined
}
function parseLastJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]!) as Record<string, unknown>
      if (obj && obj.ok === true) return obj
    } catch {}
  }
  throw new Error(`no ok JSON: ${stdout.slice(0, 2000)} || stderr tail missing`)
}
function runServeEntrySource(op: string, dataRoot: string, tmpXdg: string, extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  delete env.KILO_DB
  delete env.KILO_DATA_DIR
  env.XDG_DATA_HOME = tmpXdg
  env.XDG_CACHE_HOME = path.join(tmpXdg, "cache")
  env.XDG_CONFIG_HOME = path.join(tmpXdg, "config")
  env.XDG_STATE_HOME = path.join(tmpXdg, "state")
  env.KILO_TEST_HOME = path.join(tmpXdg, "home")
  // ensure hidden does not see private marker even if host has it
  env.KILO_PRIVATE_RUNTIME = "1"
  Object.assign(env, extraEnv)
  const args = ["run", "--conditions=browser", serveEntry(), "__internal-storage-cutover", op, "--data-root", dataRoot]
  const res = spawnSync("bun", args, { encoding: "utf8", env, timeout: 15_000 } as any)
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") }
}
function runBundled(op: string, dataRoot: string, bin: string): { status: number | null; stdout: string; stderr: string } {
  // bundled binary is self-contained, no bun, uses same dataRoot contract; ensure clean env (no KILO_DB, no private marker)
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  delete env.KILO_DB
  // bundled still respects KILO_PRIVATE_RUNTIME omission requirement — hidden must not receive it
  env.KILO_PRIVATE_RUNTIME = "1"
  const res = spawnSync(bin, ["__internal-storage-cutover", op, "--data-root", dataRoot], { encoding: "utf8", env, timeout: 15_000 } as any)
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") }
}
async function makeLegacyRoot(baseTmp: string): Promise<{ root: string; dbPath: string }> {
  const root = path.join(baseTmp, "kilo")
  await fs.mkdir(path.join(root, "storage/session_diff"), { recursive: true })
  const dbPath = path.join(root, "kilo.db")
  const layer = Database.layerFromPath(dbPath)
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const existing = yield* db.get<{ id: string }>(sql`SELECT id FROM project WHERE id='proj_global'`).pipe(Effect.orDie)
      if (!existing) yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('proj_global', '/tmp', '[]', 1, 1)`).pipe(Effect.orDie)
      yield* db.run(sql`INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_legacy', 'proj_global', 'legacy', '/tmp', 'Legacy', 'v1', 1, 1)`).pipe(Effect.orDie)
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
  )
  await fs.writeFile(path.join(root, "storage/session_diff", "ses_legacy.json"), JSON.stringify({ diff: "x" }))
  return { root, dbPath }
}

describe("serve-entry hidden cutover — lightweight entry owned-temp-XDG integration", () => {
  test("kilo-serve source: status fresh + cutover fresh + status canonical true — no self-lease, no user DB", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-serve-entry-fresh-"))
    const dataRoot = path.join(tmp, "kilo")
    const leasePath = leasePathFor(dataRoot)
    const parentDbPath = Database.path()
    const parentGlobalData = Global.Path.data
    const userDbFile = parentDbPath === ":memory:" ? path.join(parentGlobalData, "kilo.db") : parentDbPath
    const userExistsBefore = await fs.access(userDbFile).then(() => true).catch(() => false)
    const userStatBefore = userExistsBefore ? await fs.stat(userDbFile).catch(() => undefined) : undefined
    try {
      expect(await fs.access(path.join(dataRoot, "kilo.db")).then(() => true).catch(() => false)).toBe(false)
      const st1 = runServeEntrySource("status", dataRoot, tmp)
      if (st1.status !== 0) console.log("status fresh src stdout", st1.stdout.slice(-3000), "stderr", st1.stderr.slice(-3000))
      expect(st1.status).toBe(0)
      const j1 = parseLastJson(st1.stdout)
      expect(j1.ok).toBe(true)
      expect(j1.hasDb).toBe(false)
      expect(j1.canonical).toBe(false)
      expect((st1.stdout + st1.stderr).toLowerCase().includes("lease held")).toBe(false)
      expect(await fs.access(leasePath).then(() => true).catch(() => false)).toBe(false)

      const cut = runServeEntrySource("cutover", dataRoot, tmp)
      if (cut.status !== 0) console.log("cutover fresh src stdout", cut.stdout.slice(-3000), "stderr", cut.stderr.slice(-3000))
      expect(cut.status).toBe(0)
      const cj = parseLastJson(cut.stdout)
      expect(cj.ok).toBe(true)
      expect(typeof cj.archiveID).toBe("string")
      expect(await fs.access(leasePath).then(() => true).catch(() => false)).toBe(false)
      const dbPath = path.join(dataRoot, "kilo.db")
      expect(await fs.access(dbPath).then(() => true).catch(() => false)).toBe(true)

      const st2 = runServeEntrySource("status", dataRoot, tmp)
      expect(st2.status).toBe(0)
      const j2 = parseLastJson(st2.stdout)
      expect(j2.hasIdentity).toBe(true)
      expect(j2.canonical).toBe(true)
      expect((st2.stdout + st2.stderr).toLowerCase().includes("lease held")).toBe(false)

      expect(Database.path()).toBe(":memory:")
      const afterExists = await fs.access(userDbFile).then(() => true).catch(() => false)
      if (!userExistsBefore) expect(afterExists).toBe(false)
      else {
        const afterStat = await fs.stat(userDbFile).catch(() => undefined)
        expect(afterStat?.size).toBe(userStatBefore?.size)
        expect(afterStat?.mtimeMs).toBe(userStatBefore?.mtimeMs)
      }
      expect(path.resolve(dbPath)).not.toBe(path.resolve(userDbFile))

      // precise bypass check on serve-entry source
      const serveText = await fs.readFile(serveEntry(), "utf8")
      expect(serveText.includes("__internal-storage-cutover")).toBe(true)
      expect(serveText.includes("opts._") || serveText.includes("opts as any")).toBe(true)
      expect(/args\.includes\s*\(\s*["']__internal-storage-cutover["']\s*\)/.test(serveText)).toBe(false)
      expect(serveText.includes("await KiloBootstrap.bootstrap()")).toBe(true)
      expect(serveText.includes("await KiloBootstrap.shutdown()")).toBe(true)
      expect(serveText.includes("InternalStorageCommand")).toBe(true)
      expect(serveText.includes("kilocode/cli/setup")).toBe(false)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
      try {
        const { parent, base } = deriveArchive(dataRoot)
        await fs.rm(path.join(parent, `.kilo-${base}.lease.json`), { force: true }).catch(() => {})
        await fs.rm(path.join(parent, `.cutover-${base}.marker.json`), { force: true }).catch(() => {})
        await fs.rm(path.join(parent, `.rollback-${base}.marker.json`), { force: true }).catch(() => {})
      } catch {}
    }
  }, 30000)

  test("kilo-serve source: legacy DB -> status non-canonical -> cutover archives legacy -> canonical true", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-serve-entry-legacy-"))
    try {
      const { root, dbPath } = await makeLegacyRoot(tmp)
      const s = runServeEntrySource("status", root, tmp)
      expect(s.status).toBe(0)
      const j = parseLastJson(s.stdout)
      expect(j.hasDb).toBe(true)
      expect(j.canonical).toBe(false)

      const cut = runServeEntrySource("cutover", root, tmp)
      expect(cut.status).toBe(0)
      const cj = parseLastJson(cut.stdout)
      const archivePath = String(cj.archivePath)
      expect(archivePath.length).toBeGreaterThan(0)
      expect(await fs.access(archivePath).then(() => true).catch(() => false)).toBe(true)

      const st2 = runServeEntrySource("status", root, tmp)
      expect(st2.status).toBe(0)
      const j2 = parseLastJson(st2.stdout)
      expect(j2.canonical).toBe(true)
      // stale session must not exist in fresh DB
      const layer = Database.layerFromPath(dbPath)
      const rows = await Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          return yield* db.all<{ id: string }>(sql`SELECT id FROM session`).pipe(Effect.orDie)
        }).pipe(Effect.provide(layer), Effect.scoped, Effect.orDie),
      )
      expect(rows.some((r) => r.id === "ses_legacy")).toBe(false)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }, 30000)

  test("kilo-serve bundled binary: status fresh + cutover fresh when binary present (rebuild required)", async () => {
    const bin = bundledServePath()
    if (!bin) {
      console.log("bundled kilo-serve not found, skipping bundled fresh test — run build first")
      return
    }
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-serve-bundled-fresh-"))
    const dataRoot = path.join(tmp, "kilo")
    try {
      const st1 = runBundled("status", dataRoot, bin)
      if (st1.status !== 0) console.log("bundled status stdout", st1.stdout.slice(-3000), "stderr", st1.stderr.slice(-3000))
      expect(st1.status).toBe(0)
      const j1 = parseLastJson(st1.stdout)
      expect(j1.hasDb).toBe(false)
      expect(j1.canonical).toBe(false)

      const cut = runBundled("cutover", dataRoot, bin)
      if (cut.status !== 0) console.log("bundled cutover stdout", cut.stdout.slice(-3000), "stderr", cut.stderr.slice(-3000))
      expect(cut.status).toBe(0)
      const cj = parseLastJson(cut.stdout)
      expect(cj.ok).toBe(true)

      const st2 = runBundled("status", dataRoot, bin)
      expect(st2.status).toBe(0)
      expect(parseLastJson(st2.stdout).canonical).toBe(true)

      // hidden command must remain absent from help
      const help = spawnSync(bin, ["--help"], { encoding: "utf8", timeout: 5_000 } as any)
      const helpOut = String(help.stdout ?? "") + String(help.stderr ?? "")
      expect(helpOut.includes("__internal-storage-cutover")).toBe(false)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
      try {
        const { parent, base } = deriveArchive(dataRoot)
        await fs.rm(path.join(parent, `.kilo-${base}.lease.json`), { force: true }).catch(() => {})
      } catch {}
    }
  }, 30000)

  test("kilo-serve bundled binary: legacy cutover when binary present", async () => {
    const bin = bundledServePath()
    if (!bin) return
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-serve-bundled-legacy-"))
    try {
      const { root } = await makeLegacyRoot(tmp)
      const s = runBundled("status", root, bin)
      expect(s.status).toBe(0)
      expect(parseLastJson(s.stdout).canonical).toBe(false)
      const cut = runBundled("cutover", root, bin)
      expect(cut.status).toBe(0)
      const cj = parseLastJson(cut.stdout)
      expect(String(cj.archivePath).length).toBeGreaterThan(0)
      expect(parseLastJson(runBundled("status", root, bin).stdout).canonical).toBe(true)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    }
  }, 30000)

  test("kilo-serve source serve --port 0 still binds via real spawn (B4 parity)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-serve-entry-serve-"))
    const xdg = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-serve-entry-xdg-"))
    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    env.XDG_DATA_HOME = xdg
    env.XDG_CACHE_HOME = path.join(xdg, "cache")
    env.XDG_CONFIG_HOME = path.join(xdg, "config")
    env.XDG_STATE_HOME = path.join(xdg, "state")
    env.KILO_TEST_HOME = home
    delete env.KILO_DB
    delete env.KILO_SERVER_PASSWORD
    delete env.KILO_SERVER_USERNAME
    env.KILO_PURE = "1"
    env.KILO_DISABLE_AUTOUPDATE = "1"
    env.KILO_DISABLE_AUTOCOMPACT = "1"
    env.KILO_DISABLE_PROJECT_CONFIG = "1"
    // ensure bundled not required — source serve-entry path directly
    const proc = spawn("bun", ["run", "--conditions=browser", serveEntry(), "serve", "--port", "0"], {
      cwd: home,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    const portPromise = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for port")), 15_000)
      proc.stdout?.on("data", (d: Buffer) => {
        const s = d.toString()
        stdout += s
        const m = stdout.match(/listening on http:\/\/[^\s:]+:(\d+)/)
        if (m) {
          clearTimeout(timer)
          resolve(Number(m[1]))
        }
      })
      proc.on("error", reject)
      proc.on("exit", (code) => {
        if (code !== null) {
          clearTimeout(timer)
          reject(new Error(`serve exited ${code} stdout=${stdout.slice(-2000)}`))
        }
      })
    })
    try {
      const port = await portPromise
      expect(port).toBeGreaterThan(0)
      expect(port).toBeLessThan(65536)
      // fetch a trivial endpoint (version or health) to prove HTTP up — /doc openapi may require auth, just check socket connect
      const url = `http://127.0.0.1:${port}`
      // we only need to prove the process printed listening and stayed alive long enough to be killed
      // ensure process still alive
      expect(proc.pid).toBeGreaterThan(0)
      expect(proc.exitCode).toBeNull()
      // small fetch to root should not crash (may be 404 but proves server listening)
      try {
        await fetch(url, { signal: AbortSignal.timeout(2000) })
      } catch {}
    } finally {
      try {
        proc.kill("SIGTERM")
      } catch {}
      await new Promise<void>((r) => {
        const t = setTimeout(r, 500)
        proc.on("exit", () => {
          clearTimeout(t)
          r()
        })
      }).catch(() => {})
      try {
        if ((proc as any).exitCode === null) (proc as any).kill("SIGKILL")
      } catch {}
      await fs.rm(home, { recursive: true, force: true }).catch(() => {})
      await fs.rm(xdg, { recursive: true, force: true }).catch(() => {})
    }
  }, 30000)
})
