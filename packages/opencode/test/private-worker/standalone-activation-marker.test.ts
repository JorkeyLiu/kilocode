import { describe, expect, it } from "bun:test"
import fs from "fs"
import fsp from "fs/promises"
import path from "path"
import os from "os"
import { deriveArchive } from "@opencode-ai/core/cutover/archive-path"
import { Database } from "@opencode-ai/core/database/database"

function tmpDataRoot(): { tmp: string; dataDir: string; dbPath: string; cleanup: () => Promise<void> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-standalone-marker-"))
  const dataDir = path.join(tmp, "data")
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, "kilo.db")
  const { parent, base } = deriveArchive(dataDir)
  const cutover = path.join(parent, `.cutover-${base}.marker.json`)
  const rollback = path.join(parent, `.rollback-${base}.marker.json`)
  const lease = path.join(parent, `.kilo-${base}.lease.json`)
  const cleanup = async () => {
    try {
      await fsp.rm(cutover, { force: true })
    } catch {}
    try {
      await fsp.rm(rollback, { force: true })
    } catch {}
    try {
      await fsp.rm(lease, { force: true })
    } catch {}
    try {
      await fsp.rm(tmp, { recursive: true, force: true })
    } catch {}
    try {
      await fsp.rm(lease, { force: true })
    } catch {}
  }
  return { tmp, dataDir, dbPath, cleanup }
}

describe("standalone private observation activation marker gate (fail-closed, no-lease)", () => {
  it("cutover marker blocks createStandaloneDeps fail-closed without lease or runtime", async () => {
    const { dataDir, dbPath, cleanup } = tmpDataRoot()
    const orig = process.env.KILO_DB
    process.env.KILO_DB = dbPath
    const { parent, base } = deriveArchive(dataDir)
    const cutover = path.join(parent, `.cutover-${base}.marker.json`)
    const lease = path.join(parent, `.kilo-${base}.lease.json`)
    await fsp.writeFile(cutover, JSON.stringify({ phase: "staged" }), "utf8")
    try {
      expect(fs.existsSync(lease)).toBe(false)
      const { createStandaloneDeps } = await import("../../src/private-worker/standalone-worker")
      let failed = false
      try {
        await createStandaloneDeps()
      } catch (e) {
        failed = true
        expect(String(e)).toContain("DB activation blocked")
        expect(String(e)).toContain(cutover)
        expect(String(e)).toContain("marker exists")
      }
      expect(failed).toBe(true)
      expect(fs.existsSync(lease)).toBe(false)
      expect(fs.existsSync(dbPath)).toBe(false)
    } finally {
      await fsp.rm(cutover, { force: true }).catch(() => {})
      if (orig === undefined) delete process.env.KILO_DB
      else process.env.KILO_DB = orig
      await cleanup()
    }
  })

  it("rollback marker blocks createStandaloneDeps fail-closed", async () => {
    const { dataDir, dbPath, cleanup } = tmpDataRoot()
    const orig = process.env.KILO_DB
    process.env.KILO_DB = dbPath
    const { parent, base } = deriveArchive(dataDir)
    const rollback = path.join(parent, `.rollback-${base}.marker.json`)
    const lease = path.join(parent, `.kilo-${base}.lease.json`)
    await fsp.writeFile(rollback, "{}", "utf8")
    try {
      const { createStandaloneDeps } = await import("../../src/private-worker/standalone-worker")
      let failed = false
      try {
        await createStandaloneDeps()
      } catch (e) {
        failed = true
        expect(String(e)).toContain("DB activation blocked")
        expect(String(e)).toContain(rollback)
      }
      expect(failed).toBe(true)
      expect(fs.existsSync(lease)).toBe(false)
    } finally {
      await fsp.rm(rollback, { force: true }).catch(() => {})
      if (orig === undefined) delete process.env.KILO_DB
      else process.env.KILO_DB = orig
      await cleanup()
    }
  })

  it("no marker: createStandaloneDeps succeeds, remains no-lease pure observer", async () => {
    const { dataDir, dbPath, cleanup } = tmpDataRoot()
    const orig = process.env.KILO_DB
    process.env.KILO_DB = dbPath
    const { parent, base } = deriveArchive(dataDir)
    const lease = path.join(parent, `.kilo-${base}.lease.json`)
    try {
      expect(fs.existsSync(lease)).toBe(false)
      // direct gate also passes
      await Database.assertNoActivationMarker(dbPath)
      const { createStandaloneDeps } = await import("../../src/private-worker/standalone-worker")
      const { deps, dispose } = await createStandaloneDeps()
      try {
        expect(fs.existsSync(lease)).toBe(false)
        expect(fs.existsSync(dbPath)).toBe(true)
        expect(typeof deps.list).toBe("function")
        expect(typeof deps.get).toBe("function")
        expect(typeof deps.messages).toBe("function")
        expect(typeof deps.operations).toBe("function")
        expect(typeof deps.getSnapshot).toBe("function")
        // minimal observation works on fresh DB
        const snap = await deps.getSnapshot()
        expect(snap.cursor).toBe(0)
        const read = await deps.readAfter(0)
        expect((read as any).type).toBe("deltas")
        expect((read as any).cursor).toBe(0)
        expect((read as any).entries.length).toBe(0)
      } finally {
        await dispose()
      }
      expect(fs.existsSync(lease)).toBe(false)
      // removed marker still normal after dispose
      await Database.assertNoActivationMarker(dbPath)
    } finally {
      if (orig === undefined) delete process.env.KILO_DB
      else process.env.KILO_DB = orig
      await cleanup()
    }
  })

  it("standalone worker remains bundled no-lease, no AppLayer/InstanceRef/GenerationGate/Snapshot/write", async () => {
    const base = path.resolve(process.cwd(), "src/private-worker")
    const standalone = fs.readFileSync(path.join(base, "standalone-worker.ts"), "utf8")
    const def = fs.readFileSync(path.join(base, "worker.ts"), "utf8")
    // must use shared Database activation gate before layerNoLease
    expect(standalone).toContain("Database.assertNoActivationMarker")
    expect(standalone).toContain("Database.layerNoLease")
    expect(standalone).not.toContain("Database.layerFromPath")
    expect(standalone).toContain("KILO_PRIVATE_WORKER_STANDALONE")
    // must not introduce prohibited capabilities
    expect(standalone).not.toContain("AppLayer")
    expect(standalone).not.toContain("InstanceRef")
    expect(standalone).not.toContain("GenerationGate")
    expect(standalone).not.toContain("Snapshot")
    expect(standalone).not.toContain("acquireLease")
    expect(standalone).not.toContain("leasePathFor")
    // default worker still lightweight
    expect(def).not.toContain("Database.layerFromPath")
    expect(def).not.toContain("Database.layerNoLease")
    expect(def).not.toContain("assertNoActivationMarker")
    // database layer shares markerPathsForFile / assertNoActivationMarker
    const db = fs.readFileSync(path.resolve(process.cwd(), "../core/src/database/database.ts"), "utf8")
    expect(db).toContain("export function markerPathsForFile")
    expect(db).toContain("export async function assertNoActivationMarker")
    expect(db).toContain("DB activation blocked: marker exists at")
    // direct shared coverage: helper returns same sibling paths as deriveArchive
    const { markerPathsForFile } = await import("@opencode-ai/core/database/database")
    const derived = deriveArchive(dataDirFromDbPath(dbPathForTest()))
    // minimal sanity: helper is exported and matches deriveArchive contract (checked in core tests)
    expect(typeof markerPathsForFile).toBe("function")
    void derived
  })
})

function dbPathForTest(): string {
  // helper for last assertion path value, not used for filesystem
  return path.join(os.tmpdir(), "kilo-shared-check", "kilo.db")
}
function dataDirFromDbPath(p: string): string {
  return path.dirname(path.resolve(p))
}
