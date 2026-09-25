import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { spawnSync } from "child_process"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { deriveArchive } from "@opencode-ai/core/cutover/archive-path"
import { leasePathFor } from "@opencode-ai/core/cutover/lease"

function repoRoot(): string {
  return path.resolve((import.meta as any).dir, "../../..")
}
function cliEntry(): string {
  return path.join(repoRoot(), "packages/opencode/src/index.ts")
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

function runCutoverCli(op: string, dataRoot: string, tmpXdg: string): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  // Remove KILO_DB so Database.path() resolves via XDG_DATA_HOME/kilo
  delete env.KILO_DB
  // Owned temp XDG matching Database.path(): XDG_DATA_HOME=<tmp>, dataRoot=<tmp>/kilo => Global.Path.data === <tmp>/kilo
  env.XDG_DATA_HOME = tmpXdg
  env.XDG_CACHE_HOME = path.join(tmpXdg, "cache")
  env.XDG_CONFIG_HOME = path.join(tmpXdg, "config")
  env.XDG_STATE_HOME = path.join(tmpXdg, "state")
  env.KILO_TEST_HOME = path.join(tmpXdg, "home")
  // Ensure clean slate; delete potential KILO_DATA_DIR overrides
  delete env.KILO_DATA_DIR
  const args = ["run", "--conditions=browser", cliEntry(), "__internal-storage-cutover", op, "--data-root", dataRoot]
  const res = spawnSync("bun", args, { encoding: "utf8", env, timeout: 15_000 } as any)
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") }
}

describe("internal-storage bootstrap bypass regressions (real packaged CLI)", () => {
  test("status fresh + cutover via owned temp XDG matching Database.path() — no self-lease, no user DB", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-cutover-bypass-"))
    const dataRoot = path.join(tmp, "kilo") // XDG_DATA_HOME/kilo per global.ts: data = join(clean(xdgData)!, "kilo")
    const leasePath = leasePathFor(dataRoot)
    // capture parent-process identity (should be :memory: in opencode test preload)
    const parentDbPath = Database.path()
    const parentGlobalData = Global.Path.data
    const userDbFile = parentDbPath === ":memory:" ? path.join(parentGlobalData, "kilo.db") : parentDbPath
    const userDbExistsBefore = await fs.access(userDbFile).then(() => true).catch(() => false)
    const userDbStatBefore = userDbExistsBefore ? await fs.stat(userDbFile).catch(() => undefined) : undefined

    try {
      // Ensure fresh: no DB yet
      expect(await fs.access(path.join(dataRoot, "kilo.db")).then(() => true).catch(() => false)).toBe(false)
      expect(await fs.access(leasePath).then(() => true).catch(() => false)).toBe(false)

      // 1) status fresh must succeed without self-lease (bootstrap bypass)
      const st1 = runCutoverCli("status", dataRoot, tmp)
      // Debug if fails
      if (st1.status !== 0) {
        // eslint-disable-next-line no-console
        console.log("status fresh stdout", st1.stdout.slice(-3000), "stderr", st1.stderr.slice(-3000))
      }
      expect(st1.status).toBe(0)
      const j1 = parseLastJson(st1.stdout)
      expect(j1.ok).toBe(true)
      expect(j1.hasDb).toBe(false)
      expect(j1.canonical).toBe(false)
      // no self-lease: status is read-only and bootstrap-skipped, so no lease file created, and no "lease held" error
      expect((st1.stdout + st1.stderr).toLowerCase().includes("lease held")).toBe(false)
      expect(await fs.access(leasePath).then(() => true).catch(() => false)).toBe(false)
      // no DB created by read-only status
      expect(await fs.access(path.join(dataRoot, "kilo.db")).then(() => true).catch(() => false)).toBe(false)

      // 2) cutover must succeed under same owned XDG (fresh bootstrap path)
      const cut = runCutoverCli("cutover", dataRoot, tmp)
      if (cut.status !== 0) {
        // eslint-disable-next-line no-console
        console.log("cutover stdout", cut.stdout.slice(-3000), "stderr", cut.stderr.slice(-3000))
      }
      expect(cut.status).toBe(0)
      const cj = parseLastJson(cut.stdout)
      expect(cj.ok).toBe(true)
      expect(typeof cj.archiveID).toBe("string")
      // cutover owns lease internally and releases it
      expect(await fs.access(leasePath).then(() => true).catch(() => false)).toBe(false)
      expect((cut.stdout + cut.stderr).toLowerCase().includes("lease held")).toBe(false)
      // DB now exists at canonical path matching Database.path() in child (tmp/kilo/kilo.db)
      const dbPath = path.join(dataRoot, "kilo.db")
      expect(await fs.access(dbPath).then(() => true).catch(() => false)).toBe(true)
      const stSize = (await fs.stat(dbPath)).size
      expect(stSize).toBeGreaterThan(0)

      // 3) status again should now be canonical true without self-lease
      const st2 = runCutoverCli("status", dataRoot, tmp)
      expect(st2.status).toBe(0)
      const j2 = parseLastJson(st2.stdout)
      expect(j2.ok).toBe(true)
      expect(j2.hasDb).toBe(true)
      expect(j2.hasIdentity).toBe(true)
      expect(j2.canonical).toBe(true)
      expect((st2.stdout + st2.stderr).toLowerCase().includes("lease held")).toBe(false)
      expect(await fs.access(leasePath).then(() => true).catch(() => false)).toBe(false)

      // 4) no user DB mutation: parent's Global.Path.data/kilo.db untouched, Database.path() still :memory:
      expect(Database.path()).toBe(":memory:")
      expect(Database.path()).toBe(parentDbPath)
      const userDbExistsAfter = await fs.access(userDbFile).then(() => true).catch(() => false)
      if (!userDbExistsBefore) {
        expect(userDbExistsAfter).toBe(false)
      } else {
        // if it existed before (unlikely with :memory: but keep guard), ensure size/mtime unchanged
        const afterStat = await fs.stat(userDbFile).catch(() => undefined)
        expect(afterStat?.size).toBe(userDbStatBefore?.size)
        expect(afterStat?.mtimeMs).toBe(userDbStatBefore?.mtimeMs)
      }
      // Owned tmp/kilo/kilo.db is not the user DB path
      expect(path.resolve(dbPath)).not.toBe(path.resolve(userDbFile))
      expect(path.resolve(dataRoot)).not.toBe(path.resolve(parentGlobalData))

      // 5) precise match check: source must not use naive args.includes for bypass, must use parsed opts._
      const indexText = await fs.readFile(path.join(repoRoot(), "packages/opencode/src/index.ts"), "utf8")
      expect(indexText.includes('__internal-storage-cutover')).toBe(true)
      // middleware must check parsed positional, not naive includes
      expect(indexText.includes("opts._") || indexText.includes("opts as any")).toBe(true)
      // ensure we don't have naive bypass pattern: `args.includes("__internal-storage-cutover")` should not exist as bypass condition
      // (status/cutover internal-storage file may contain string, but index.ts must not)
      const naivePattern = /args\.includes\s*\(\s*["']__internal-storage-cutover["']\s*\)/
      expect(naivePattern.test(indexText)).toBe(false)
      // also ensure bootstrap is still present for normal commands (serve etc)
      expect(indexText.includes("await KiloCli.bootstrap()")).toBe(true)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
      // also clean sibling lease/marker that might be beside tmp/kilo
      try {
        const { parent, base } = deriveArchive(dataRoot)
        await fs.rm(path.join(parent, `.kilo-${base}.lease.json`), { force: true }).catch(() => {})
        await fs.rm(path.join(parent, `.cutover-${base}.marker.json`), { force: true }).catch(() => {})
        await fs.rm(path.join(parent, `.rollback-${base}.marker.json`), { force: true }).catch(() => {})
      } catch {}
    }
  }, 30000)
})
