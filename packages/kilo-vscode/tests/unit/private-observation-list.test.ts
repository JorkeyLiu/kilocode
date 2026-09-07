import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PrivateObservationService } from "../../src/private-worker/private-observation-service"
import { OBSERVATION_METHODS, OBSERVATION_VERSION } from "../../src/private-worker/observation"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import { encodeGlobalListCursor } from "../../src/private-worker/session-cursor"

function leasePathForDbFile(file: string): string {
  const abs = path.resolve(file)
  const dir = path.dirname(abs)
  const parent = path.dirname(dir)
  const base = path.basename(dir)
  if (!base || base === "." || base === "/") return `${abs}.lease.json`
  return path.join(parent, `.kilo-${base}.lease.json`)
}

function makeTmpEnv(): { dbPath: string; xdg: Record<string, string>; cleanup: () => Promise<void> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-list-"))
  const dataDir = path.join(tmp, "data")
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, "kilo.db")
  const xdg = {
    XDG_DATA_HOME: path.join(tmp, "xdg-data"),
    XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
    XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
    XDG_STATE_HOME: path.join(tmp, "xdg-state"),
  }
  for (const v of Object.values(xdg)) fs.mkdirSync(v, { recursive: true })
  const cleanup = async () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {}
    const lease = leasePathForDbFile(dbPath)
    try {
      fs.rmSync(lease, { force: true })
    } catch {}
  }
  return { dbPath, xdg, cleanup }
}

describe("PrivateObservationService.list delegation and gating", () => {
  it("gate-off list rejects Not started, no host, no lease", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const svc = new PrivateObservationService({ enabled: false, dbPath, env: xdg })
    try {
      expect(svc.isEnabled()).toBe(false)
      let threw = false
      try {
        await svc.list({ limit: 2 })
      } catch (e) {
        threw = true
        expect(String((e as Error).message)).toMatch(/Not started/)
      }
      expect(threw).toBe(true)
      expect(svc.getHost()).toBeNull()
      expect(fs.existsSync(lease)).toBe(false)
      const offInit = await svc.initialize()
      expect(offInit).toBeUndefined()
      threw = false
      try {
        await svc.list({})
      } catch (e) {
        threw = true
        expect(String((e as Error).message)).toMatch(/Not started/)
      }
      expect(threw).toBe(true)
      expect(fs.existsSync(lease)).toBe(false)
    } finally {
      svc.dispose()
      await cleanup()
    }
  })

  it("gate-on delegates list with version 1.0, validates cursor/limit and returns minimal projection with nextCursor logic", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const lease = leasePathForDbFile(dbPath)
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
    })
    try {
      const init = (await svc.initialize()) as { protocolVersion: string }
      expect(init.protocolVersion).toBe("1.0")
      expect(svc.isStarted()).toBe(true)
      expect(fs.existsSync(lease)).toBe(false)

      const empty = (await svc.list({})) as { v: string; entries: unknown[]; nextCursor?: string }
      expect(empty.v).toBe(OBSERVATION_VERSION)
      expect(empty.entries.length).toBe(0)
      expect(empty.nextCursor).toBeUndefined()

      // insert via direct DB? Instead test wire validation without DB data: invalid limit should be InvalidParams from worker
      let bad = false
      try {
        await svc.list({ limit: 0 })
      } catch (e) {
        bad = true
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      expect(bad).toBe(true)
      bad = false
      try {
        await svc.list({ limit: 501 })
      } catch (e) {
        bad = true
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      expect(bad).toBe(true)
      bad = false
      try {
        await svc.list({ cursor: "bad" })
      } catch (e) {
        bad = true
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      expect(bad).toBe(true)

      // create a couple sessions via SDK? Use direct DB insertion via service? For equivalence, we test delegation works with real DB: insert via raw DB layerNoLease then list.
      const { Database } = await import("@opencode-ai/core/database/database")
      const { SessionTable } = await import("@opencode-ai/core/session/sql")
      const { ProjectTable } = await import("@opencode-ai/core/project/sql")
      const { Effect, ManagedRuntime } = await import("effect")
      const layer = Database.layerNoLease(dbPath)
      const rt = ManagedRuntime.make(layer)
      const db = await rt.runPromise(
        Effect.gen(function* () {
          return (yield* Database.Service).db
        }),
      )
      const projId = "proj_vscode_list"
      await Effect.runPromise(
        db
          .insert(ProjectTable)
          .values({
            id: projId as unknown as string,
            worktree: "/tmp/ws" as unknown as string,
            vcs: "git" as unknown as string,
            time_created: 1000,
            time_updated: 1000,
            sandboxes: [] as unknown as string[],
          } as never)
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie),
      )
      for (const row of [
        { id: "ses_vs_a", title: "vs_a", updated: 100, created: 90 },
        { id: "ses_vs_b", title: "vs_b", updated: 200, created: 190 },
      ]) {
        await Effect.runPromise(
          db
            .insert(SessionTable)
            .values({
              id: row.id as unknown as string,
              project_id: projId as unknown as string,
              slug: `slug-${row.id}`,
              directory: "/tmp/ws",
              title: row.title,
              version: "1",
              parent_id: null as unknown as string,
              time_created: row.created,
              time_updated: row.updated,
            } as never)
            .run()
            .pipe(Effect.orDie),
        )
      }
      await rt.dispose()

      const paged = (await svc.list({ limit: 1 })) as { v: string; entries: Array<{ id: string; title: string; parentID: string | null; directory: string; createdAt: number; updatedAt: number }>; nextCursor?: string }
      expect(paged.v).toBe("1.0")
      expect(paged.entries.length).toBe(1)
      expect(paged.entries[0]!.id).toBe("ses_vs_b")
      expect(paged.nextCursor).toBeDefined()
      const decoded = JSON.parse(Buffer.from(paged.nextCursor!, "base64url").toString("utf8")) as { v: number; updated: number; id: string }
      expect(decoded.id).toBe("ses_vs_b")
      expect(Object.keys(paged.entries[0]!).sort()).toEqual(["createdAt", "directory", "id", "parentID", "title", "updatedAt"])
      expect(paged.entries[0]!.parentID).toBeNull()
      expect((paged as unknown as Record<string, unknown>).truncated).toBeUndefined()

      const second = (await svc.list({ cursor: paged.nextCursor!, limit: 1 })) as { entries: Array<{ id: string }>; nextCursor?: string }
      expect(second.entries.length).toBe(1)
      expect(second.entries[0]!.id).toBe("ses_vs_a")
      expect(second.nextCursor).toBeUndefined()

      expect(fs.existsSync(lease)).toBe(false)
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      expect(fs.existsSync(leasePathForDbFile(dbPath))).toBe(false)
      await cleanup()
    }
  }, 20000)

  it("list after dispose rejects Not started", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({
      enabled: true,
      dbPath,
      env: xdg,
      command: "bun",
      args: ["--conditions=browser", standaloneTs],
      initializeTimeoutMs: 8000,
    })
    try {
      await svc.initialize()
      svc.dispose()
      let threw = false
      try {
        await svc.list({})
      } catch (e) {
        threw = true
        expect(String((e as Error).message)).toMatch(/Not started/)
      }
      expect(threw).toBe(true)
    } finally {
      svc.dispose()
      await cleanup()
    }
  })
})
