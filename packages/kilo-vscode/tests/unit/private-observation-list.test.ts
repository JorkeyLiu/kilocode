import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PrivateObservationService } from "../../src/private-worker/private-observation-service"
import { OBSERVATION_METHODS, OBSERVATION_VERSION, ObservationController } from "../../src/private-worker/observation"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"

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
        await svc.list({ directory: "/tmp/ws", limit: 2 })
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
        await svc.list({ directory: "/tmp/ws" })
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

      const empty = (await svc.list({ directory: "/tmp/ws" })) as { v: string; entries: unknown[]; nextCursor?: string }
      expect(empty.v).toBe(OBSERVATION_VERSION)
      expect(empty.entries.length).toBe(0)
      expect(empty.nextCursor).toBeUndefined()

      let bad = false
      try {
        await svc.list({ directory: "/tmp/ws", limit: 0 })
      } catch (e) {
        bad = true
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      expect(bad).toBe(true)
      bad = false
      try {
        await svc.list({ directory: "/tmp/ws", limit: 501 })
      } catch (e) {
        bad = true
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      expect(bad).toBe(true)
      bad = false
      try {
        await svc.list({ directory: "/tmp/ws", cursor: "bad" })
      } catch (e) {
        bad = true
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      expect(bad).toBe(true)
      bad = false
      try {
        await (svc as unknown as { list: (i: unknown) => Promise<unknown> }).list({ limit: 1 } as unknown as never)
      } catch (e) {
        bad = true
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      expect(bad).toBe(true)
      bad = false
      try {
        await svc.list({ directory: "relative/path", limit: 1 })
      } catch (e) {
        bad = true
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      expect(bad).toBe(true)

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

      const paged = (await svc.list({ directory: "/tmp/ws", limit: 1 })) as {
        v: string
        entries: Array<{ id: string; title: string; parentID: string | null; directory: string; projectID: string; createdAt: number; updatedAt: number }>
        nextCursor?: string
      }
      expect(paged.v).toBe("1.0")
      expect(paged.entries.length).toBe(1)
      expect(paged.entries[0]!.id).toBe("ses_vs_b")
      expect(paged.nextCursor).toBeDefined()
      const decoded = JSON.parse(Buffer.from(paged.nextCursor!, "base64url").toString("utf8")) as { v: number; updated: number; id: string }
      expect(decoded.id).toBe("ses_vs_b")
      expect(Object.keys(paged.entries[0]!).sort()).toEqual(["createdAt", "directory", "id", "parentID", "projectID", "title", "updatedAt"])
      expect(paged.entries[0]!.projectID).toBe("proj_vscode_list")
      expect(paged.entries[0]!.parentID).toBeNull()
      expect((paged as unknown as Record<string, unknown>).truncated).toBeUndefined()

      const second = (await svc.list({ directory: "/tmp/ws", cursor: paged.nextCursor!, limit: 1 })) as { entries: Array<{ id: string }>; nextCursor?: string }
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
        await svc.list({ directory: "/tmp/ws" })
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

  it("cross-directory isolation via service", async () => {
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
      const { Database } = await import("@opencode-ai/core/database/database")
      const { SessionTable } = await import("@opencode-ai/core/session/sql")
      const { ProjectTable } = await import("@opencode-ai/core/project/sql")
      const { Effect, ManagedRuntime } = await import("effect")
      const dirA = "/tmp/ws-a"
      const dirB = "/tmp/ws-b"
      const layer = Database.layerNoLease(dbPath)
      const rt = ManagedRuntime.make(layer)
      const db = await rt.runPromise(Effect.gen(function* () { return (yield* Database.Service).db }))
      await Effect.runPromise(
        db.insert(ProjectTable).values({ id: "proj_a" as unknown as string, worktree: dirA as unknown as string, vcs: "git" as unknown as string, time_created: 1000, time_updated: 1000, sandboxes: [] as unknown as string[] } as never).onConflictDoNothing().run().pipe(Effect.orDie),
      )
      for (const row of [
        { id: "ses_cross_a1", dir: dirA, updated: 100, created: 90 },
        { id: "ses_cross_a2", dir: dirA, updated: 200, created: 190 },
        { id: "ses_cross_b1", dir: dirB, updated: 300, created: 290 },
      ]) {
        await Effect.runPromise(
          db.insert(SessionTable).values({ id: row.id as unknown as string, project_id: "proj_a" as unknown as string, slug: `slug-${row.id}`, directory: row.dir, title: row.id, version: "1", parent_id: null as unknown as string, time_created: row.created, time_updated: row.updated } as never).run().pipe(Effect.orDie),
        )
      }
      await rt.dispose()
      const outA = (await svc.list({ directory: dirA, limit: 10 })) as { entries: Array<{ id: string }> }
      expect(outA.entries.map((e) => e.id).sort()).toEqual(["ses_cross_a1", "ses_cross_a2"])
      const outB = (await svc.list({ directory: dirB, limit: 10 })) as { entries: Array<{ id: string }> }
      expect(outB.entries.map((e) => e.id)).toEqual(["ses_cross_b1"])
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      await cleanup()
    }
  }, 20000)

  it("default excludes archived, archived=true includes", async () => {
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
      const { Database } = await import("@opencode-ai/core/database/database")
      const { SessionTable } = await import("@opencode-ai/core/session/sql")
      const { ProjectTable } = await import("@opencode-ai/core/project/sql")
      const { Effect, ManagedRuntime } = await import("effect")
      const dir = "/tmp/ws"
      const layer = Database.layerNoLease(dbPath)
      const rt = ManagedRuntime.make(layer)
      const db = await rt.runPromise(Effect.gen(function* () { return (yield* Database.Service).db }))
      await Effect.runPromise(db.insert(ProjectTable).values({ id: "proj_arch" as unknown as string, worktree: dir as unknown as string, vcs: "git" as unknown as string, time_created: 1, time_updated: 1, sandboxes: [] as unknown as string[] } as never).onConflictDoNothing().run().pipe(Effect.orDie))
      await Effect.runPromise(db.insert(SessionTable).values({ id: "ses_active" as unknown as string, project_id: "proj_arch" as unknown as string, slug: "slug-active", directory: dir, title: "active", version: "1", parent_id: null as unknown as string, time_created: 10, time_updated: 100 } as never).run().pipe(Effect.orDie))
      await Effect.runPromise(db.insert(SessionTable).values({ id: "ses_archived" as unknown as string, project_id: "proj_arch" as unknown as string, slug: "slug-arch", directory: dir, title: "arch", version: "1", parent_id: null as unknown as string, time_created: 10, time_updated: 200, time_archived: Date.now() as unknown as number } as never).run().pipe(Effect.orDie))
      await rt.dispose()
      const def = (await svc.list({ directory: dir, limit: 10 })) as { entries: Array<{ id: string }> }
      expect(def.entries.map((e) => e.id)).toEqual(["ses_active"])
      const incl = (await svc.list({ directory: dir, archived: true, limit: 10 })) as { entries: Array<{ id: string }> }
      expect(incl.entries.map((e) => e.id).sort()).toEqual(["ses_active", "ses_archived"])
      const explicitFalse = (await svc.list({ directory: dir, archived: false, limit: 10 })) as { entries: Array<{ id: string }> }
      expect(explicitFalse.entries.map((e) => e.id)).toEqual(["ses_active"])
    } finally {
      svc.dispose()
      await new Promise((r) => setTimeout(r, 200))
      await cleanup()
    }
  }, 20000)

  it("mirrored service request forwarding captures directory/archived", async () => {
    const ctrl = new ObservationController({
      getSnapshot: async () => ({ cursor: 0, snapshot: null }),
      readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
      ack: async () => {},
      list: async (input) => {
        expect(input.directory).toBe("/tmp/ws")
        expect(input.archived).toBe(true)
        expect(input.limit).toBe(3)
        return { v: "1.0", entries: [] }
      },
    })
    const aToB = new PassThrough()
    const bToA = new PassThrough()
    const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
    const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
    const res = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: "/tmp/ws", archived: true, limit: 3 })) as { v: string }
    expect(res.v).toBe("1.0")
    // also test PrivateObservationService forwards via fake host
    let captured: Record<string, unknown> | undefined
    const fakeHost = { request: async (_m: string, params: unknown) => { captured = params as Record<string, unknown>; return { v: "1.0", entries: [] } } } as unknown as import("../../src/private-worker/host").PrivateWorkerHost
    const svc = new PrivateObservationService({ enabled: true, dbPath: "/tmp/fake.db" })
    ;(svc as unknown as { host: unknown }).host = fakeHost
    await svc.list({ directory: "/tmp/ws", archived: true, limit: 3 })
    expect(captured!.directory).toBe("/tmp/ws")
    expect(captured!.archived).toBe(true)
    expect(captured!.limit).toBe(3)
    expect(captured!.v).toBe("1.0")
    client.dispose()
    server.dispose()
    svc.dispose()
  })

  it("standalone adapter lexical canonicalization keeps symlink-spelled rows distinct and proves directory+archived+pagination predicates together", async () => {
    const { Database } = await import("@opencode-ai/core/database/database")
    const { SessionTable } = await import("@opencode-ai/core/session/sql")
    const { ProjectTable } = await import("@opencode-ai/core/project/sql")
    const { Effect, ManagedRuntime } = await import("effect")
    const { createSessionListDeps } = await import("../../src/private-worker/session-list-adapter")
    const { canonicalDirectory } = await import("../../src/private-worker/canonical-directory")
    const baseFs = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-sym-"))
    const target = path.join(baseFs, "target")
    fs.mkdirSync(target, { recursive: true })
    const link = path.join(baseFs, "link")
    let symlinkOk = false
    try {
      fs.symlinkSync(target, link, "dir")
      symlinkOk = true
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS" || (e as Error).message.includes("operation not permitted")) symlinkOk = false
      else throw e
    }
    const canonLink = canonicalDirectory(link)
    const canonTarget = canonicalDirectory(target)
    if (symlinkOk) expect(canonLink).not.toBe(canonTarget)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-list-sym-"))
    const dbPath = path.join(tmp, "kilo.db")
    const cleanup = () => {
      fs.rmSync(tmp, { recursive: true, force: true })
      fs.rmSync(baseFs, { recursive: true, force: true })
      const lease = path.join(path.dirname(path.dirname(dbPath)), `.kilo-${path.basename(path.dirname(dbPath))}.lease.json`)
      fs.rmSync(lease, { force: true })
    }
    try {
      const layer = Database.layerNoLease(dbPath)
      const rt = ManagedRuntime.make(layer)
      const db = await rt.runPromise(Effect.gen(function* () { return (yield* Database.Service).db }))
      const projId = "proj_vscode_sym"
      await Effect.runPromise(db.insert(ProjectTable).values({ id: projId as unknown as string, worktree: "/tmp/ws" as unknown as string, vcs: "git" as unknown as string, time_created: 1000, time_updated: 1000, sandboxes: [] as unknown as string[] } as never).onConflictDoNothing().run().pipe(Effect.orDie))
      const dirA = symlinkOk ? canonLink : canonicalDirectory(path.join(baseFs, "dirA"))
      const dirB = symlinkOk ? canonTarget : canonicalDirectory(path.join(baseFs, "other"))
      const nowArchived = Date.now()
      for (const row of [
        { id: "ses_vs_a1", dir: dirA, updated: 100, created: 90 },
        { id: "ses_vs_a_arch", dir: dirA, updated: 200, created: 190, archived: nowArchived },
        { id: "ses_vs_a2", dir: dirA, updated: 300, created: 290 },
        { id: "ses_vs_b_newer", dir: dirB, updated: 999, created: 990 },
      ]) {
        await Effect.runPromise(db.insert(SessionTable).values({ id: row.id as unknown as string, project_id: projId as unknown as string, slug: `slug-${row.id}`, directory: row.dir as unknown as string, title: row.id, version: "1", parent_id: null as unknown as string, time_created: row.created, time_updated: row.updated, time_archived: (row as { archived?: number }).archived ?? null as unknown as number } as never).run().pipe(Effect.orDie))
      }
      const deps = createSessionListDeps(db)
      const ctrl = new ObservationController({
        getSnapshot: async () => ({ cursor: 0, snapshot: null }),
        readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
        ack: async () => {},
        list: deps.list,
      })
      const aToB = new PassThrough()
      const bToA = new PassThrough()
      const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
      const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
      const rawPrimary = symlinkOk ? link : dirA
      const def = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: rawPrimary, limit: 10 })) as { entries: Array<{ id: string }> }
      expect(def.entries.map((e) => e.id).sort()).toEqual(["ses_vs_a1", "ses_vs_a2"])
      const incl = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: rawPrimary, archived: true, limit: 10 })) as { entries: Array<{ id: string }> }
      expect(incl.entries.map((e) => e.id).sort()).toEqual(["ses_vs_a1", "ses_vs_a2", "ses_vs_a_arch"])
      const p1 = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: rawPrimary, archived: true, limit: 1 })) as { entries: Array<{ id: string }>; nextCursor?: string }
      expect(p1.entries[0]!.id).toBe("ses_vs_a2")
      expect(p1.nextCursor).toBeDefined()
      const p2 = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: rawPrimary, archived: true, cursor: p1.nextCursor!, limit: 1 })) as { entries: Array<{ id: string }>; nextCursor?: string }
      expect(p2.entries[0]!.id).toBe("ses_vs_a_arch")
      expect(p2.nextCursor).toBeDefined()
      const p3 = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: rawPrimary, archived: true, cursor: p2.nextCursor!, limit: 1 })) as { entries: Array<{ id: string }>; nextCursor?: string }
      expect(p3.entries[0]!.id).toBe("ses_vs_a1")
      expect(p3.nextCursor).toBeUndefined()
      const q1 = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: rawPrimary, limit: 1 })) as { entries: Array<{ id: string }>; nextCursor?: string }
      expect(q1.entries[0]!.id).toBe("ses_vs_a2")
      const q2 = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: rawPrimary, cursor: q1.nextCursor!, limit: 1 })) as { entries: Array<{ id: string }>; nextCursor?: string }
      expect(q2.entries[0]!.id).toBe("ses_vs_a1")
      expect(q2.nextCursor).toBeUndefined()
      const rawSecondary = symlinkOk ? target : dirB
      const other = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: rawSecondary, limit: 10 })) as { entries: Array<{ id: string }> }
      expect(other.entries.map((e) => e.id)).toEqual(["ses_vs_b_newer"])
      // idempotent canonicalization
      const d1 = await deps.list({ directory: dirA, archived: true, limit: 10 })
      const d2 = await deps.list({ directory: canonicalDirectory(dirA), archived: true, limit: 10 })
      expect(d1.entries.map((e) => e.id).sort()).toEqual(d2.entries.map((e) => e.id).sort())
      if (symlinkOk) {
        const viaLink = await deps.list({ directory: link, limit: 10 })
        const viaTarget = await deps.list({ directory: target, limit: 10 })
        expect(viaLink.entries.some((e) => e.id === "ses_vs_b_newer")).toBe(false)
        expect(viaTarget.entries.some((e) => e.id === "ses_vs_a1")).toBe(false)
      }
      client.dispose()
      server.dispose()
      await rt.dispose()
    } finally {
      cleanup()
    }
  }, 20000)
})
