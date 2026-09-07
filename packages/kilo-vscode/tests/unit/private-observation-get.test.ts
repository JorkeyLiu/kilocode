import { describe, it, expect } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PrivateObservationService } from "../../src/private-worker/private-observation-service"
import { OBSERVATION_METHODS, OBSERVATION_VERSION, ObservationController } from "../../src/private-worker/observation"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"

function makeTmpEnv(): { dbPath: string; xdg: Record<string, string>; cleanup: () => Promise<void> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-get-"))
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
  }
  return { dbPath, xdg, cleanup }
}

describe("PrivateObservationService.get delegation and gating (vscode mirror)", () => {
  it("gate-off get rejects Not started, no host", async () => {
    const { dbPath, xdg, cleanup } = makeTmpEnv()
    const svc = new PrivateObservationService({ enabled: false, dbPath, env: xdg })
    try {
      expect(svc.isEnabled()).toBe(false)
      let threw = false
      try {
        await svc.get({ directory: "/tmp/ws", sessionId: "ses_a" })
      } catch (e) {
        threw = true
        expect(String((e as Error).message)).toMatch(/Not started/)
      }
      expect(threw).toBe(true)
      expect(svc.getHost()).toBeNull()
      const offInit = await svc.initialize()
      expect(offInit).toBeUndefined()
      threw = false
      try {
        await svc.get({ directory: "/tmp/ws", sessionId: "ses_a" })
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

  it("gate-on delegates get with version 1.0, validates directory/sessionId and returns found/not_found/scope_mismatch via peer", async () => {
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
    const hostBeforeDispose = () => svc.getHost()
    try {
      const init = (await svc.initialize()) as { protocolVersion: string }
      expect(init.protocolVersion).toBe("1.0")
      expect(svc.isStarted()).toBe(true)

      // empty DB -> not_found resolves
      const nf = (await svc.get({ directory: "/tmp/ws", sessionId: "ses_missing" })) as { v: string; status: string }
      expect(nf.v).toBe(OBSERVATION_VERSION)
      expect(nf.status).toBe("not_found")
      expect(Object.keys(nf).sort()).toEqual(["status", "v"])

      // invalid directory -> InvalidParams rejects
      let bad = false
      try {
        await svc.get({ directory: "relative/path", sessionId: "ses_a" })
      } catch (e) {
        bad = true
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      expect(bad).toBe(true)
      bad = false
      try {
        await svc.get({ directory: "/tmp/ws", sessionId: "bad" })
      } catch (e) {
        bad = true
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      expect(bad).toBe(true)
      // missing sessionId via any cast
      bad = false
      try {
        await (svc as unknown as { get: (i: unknown) => Promise<unknown> }).get({ directory: "/tmp/ws" } as unknown as never)
      } catch (e) {
        bad = true
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      expect(bad).toBe(true)

      // insert real session and verify found via service
      const { Database } = await import("@opencode-ai/core/database/database")
      const { SessionTable } = await import("@opencode-ai/core/session/sql")
      const { ProjectTable } = await import("@opencode-ai/core/project/sql")
      const { Effect, ManagedRuntime } = await import("effect")
      const layer = Database.layerNoLease(dbPath)
      const rt = ManagedRuntime.make(layer)
      const db = await rt.runPromise(Effect.gen(function* () { return (yield* Database.Service).db }))
      const projId = "proj_vscode_get"
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
      await Effect.runPromise(
        db
          .insert(SessionTable)
          .values({
            id: "ses_vs_get_a" as unknown as string,
            project_id: projId as unknown as string,
            slug: "slug-a",
            directory: "/tmp/ws",
            title: "vs_a",
            version: "1",
            parent_id: null as unknown as string,
            time_created: 100,
            time_updated: 200,
          } as never)
          .run()
          .pipe(Effect.orDie),
      )
      await Effect.runPromise(
        db
          .insert(SessionTable)
          .values({
            id: "ses_vs_get_b" as unknown as string,
            project_id: projId as unknown as string,
            slug: "slug-b",
            directory: "/tmp/ws-a",
            title: "vs_b",
            version: "1",
            parent_id: null as unknown as string,
            time_created: 100,
            time_updated: 200,
          } as never)
          .run()
          .pipe(Effect.orDie),
      )
      await rt.dispose()

      const found = (await svc.get({ directory: "/tmp/ws", sessionId: "ses_vs_get_a" })) as { v: string; status: string; session: { id: string; directory: string; title: string } }
      expect(found.v).toBe("1.0")
      expect(found.status).toBe("found")
      expect(found.session.id).toBe("ses_vs_get_a")
      expect(found.session.directory).toBe("/tmp/ws")
      expect(Object.keys(found.session).sort()).toEqual(["createdAt", "directory", "id", "parentID", "projectID", "title", "updatedAt"])

      const mismatch = (await svc.get({ directory: "/tmp/ws-b", sessionId: "ses_vs_get_a" })) as { status: string }
      expect(mismatch.status).toBe("scope_mismatch")

      const notFound = (await svc.get({ directory: "/tmp/ws", sessionId: "ses_not_exist" })) as { status: string }
      expect(notFound.status).toBe("not_found")

      // ensure resolves not rejects for domain statuses
      let rejected = false
      try {
        await svc.get({ directory: "/tmp/ws-b", sessionId: "ses_vs_get_a" })
      } catch {
        rejected = true
      }
      expect(rejected).toBe(false)
    } finally {
      const h = hostBeforeDispose()
      const pending = svc.getPendingShutdownHost()
      const proc = svc.getPendingShutdownProc()
      svc.dispose()
      if (h) {
        try {
          await h.waitForExit(2000)
        } catch {}
      }
      if (pending && pending !== h) {
        try {
          await pending.waitForExit(2000)
        } catch {}
      }
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        await new Promise<void>((resolve) => {
          let done = false
          const onExit = () => {
            if (done) return
            done = true
            resolve()
          }
          try {
            proc.on("exit", onExit as unknown as () => void)
          } catch {}
          try {
            proc.on("close", onExit as unknown as () => void)
          } catch {}
          setTimeout(() => {
            if (done) return
            done = true
            resolve()
          }, 2000).unref?.()
        })
      }
      // ensure host closed before deleting owned temp DB directory
      expect(svc.getHost()).toBeNull()
      await cleanup()
    }
  }, 20000)

  it("get after dispose rejects Not started", async () => {
    const svc = new PrivateObservationService({ enabled: false, dbPath: "/tmp/fake.db" })
    svc.dispose()
    let threw = false
    try {
      await svc.get({ directory: "/tmp/ws", sessionId: "ses_a" })
    } catch (e) {
      threw = true
      expect(String((e as Error).message)).toMatch(/Not started/)
    }
    expect(threw).toBe(true)
    svc.dispose()
  })

  it("mirrored controller/adapter exercised directly (not source strings only) — real DB path with empty agent", async () => {
    const { Database } = await import("@opencode-ai/core/database/database")
    const { SessionTable } = await import("@opencode-ai/core/session/sql")
    const { ProjectTable } = await import("@opencode-ai/core/project/sql")
    const { Effect, ManagedRuntime } = await import("effect")
    const { createSessionGetDeps } = await import("../../src/private-worker/session-get-adapter")
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-get-mirror-"))
    const dbPath = path.join(tmp, "kilo.db")
    const cleanup = () => {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
    try {
      const layer = Database.layerNoLease(dbPath)
      const rt = ManagedRuntime.make(layer)
      const db = await rt.runPromise(Effect.gen(function* () { return (yield* Database.Service).db }))
      await Effect.runPromise(
        db.insert(ProjectTable).values({ id: "proj_mirror" as unknown as string, worktree: "/tmp/ws" as unknown as string, vcs: "git" as unknown as string, time_created: 1, time_updated: 1, sandboxes: [] as unknown as string[] } as never).onConflictDoNothing().run().pipe(Effect.orDie),
      )
      await Effect.runPromise(
        db.insert(SessionTable).values({ id: "ses_mirror" as unknown as string, project_id: "proj_mirror" as unknown as string, slug: "slug-m", directory: "/tmp/ws", title: "mirror", version: "1", parent_id: null as unknown as string, time_created: 10, time_updated: 20, agent: "agentX" as unknown as string, summary_additions: 1 as unknown as number, summary_deletions: 2 as unknown as number, summary_files: 1 as unknown as number, summary_diffs: [{ file: "a.txt", additions: 1, deletions: 2, status: "added" }] as unknown as never, revert: { messageID: "msg_1", partID: "prt_1" } as unknown as never } as never).run().pipe(Effect.orDie),
      )
      await Effect.runPromise(
        db.insert(SessionTable).values({ id: "ses_empty_agent" as unknown as string, project_id: "proj_mirror" as unknown as string, slug: "slug-e", directory: "/tmp/ws", title: "empty", version: "1", parent_id: null as unknown as string, time_created: 10, time_updated: 20, agent: "" as unknown as string } as never).run().pipe(Effect.orDie),
      )
      const deps = createSessionGetDeps(db)
      const ctrl = new ObservationController({
        getSnapshot: async () => ({ cursor: 0, snapshot: null }),
        readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
        ack: async () => {},
        get: deps.get,
      })
      const aToB = new PassThrough()
      const bToA = new PassThrough()
      const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
      const client = new JsonRpcPeer({ reader: bToA, writer: aToB })

      const found = (await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: "/tmp/ws", sessionId: "ses_mirror" })) as { status: string; session: Record<string, unknown> }
      expect(found.status).toBe("found")
      expect(found.session.id).toBe("ses_mirror")
      expect(found.session.agent).toBe("agentX")
      expect(found.session.summary).toEqual({ additions: 1, deletions: 2, files: 1, diffs: [{ file: "a.txt", additions: 1, deletions: 2, status: "added" }] })
      expect(found.session.revert).toEqual({ messageID: "msg_1", partID: "prt_1" })

      const empty = (await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: "/tmp/ws", sessionId: "ses_empty_agent" })) as { status: string; session: Record<string, unknown> }
      expect(empty.status).toBe("found")
      expect(empty.session.agent).toBe("")
      expect(Object.keys(empty.session).includes("agent")).toBe(true)

      const nf = await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: "/tmp/ws", sessionId: "ses_missing2" })
      expect((nf as { status: string }).status).toBe("not_found")

      const sm = await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: "/tmp/other", sessionId: "ses_mirror" })
      expect((sm as { status: string }).status).toBe("scope_mismatch")

      // also directly via fake host forwarding captures params
      let captured: Record<string, unknown> | undefined
      const fakeHost = { request: async (_m: string, params: unknown) => { captured = params as Record<string, unknown>; return { v: "1.0", status: "not_found" } } } as unknown as import("../../src/private-worker/host").PrivateWorkerHost
      const svc = new PrivateObservationService({ enabled: true, dbPath: "/tmp/fake.db" })
      ;(svc as unknown as { host: unknown }).host = fakeHost
      await svc.get({ directory: "/tmp/ws", sessionId: "ses_mirror" })
      expect(captured!.directory).toBe("/tmp/ws")
      expect(captured!.sessionId).toBe("ses_mirror")
      expect(captured!.v).toBe("1.0")

      client.dispose()
      server.dispose()
      svc.dispose()
      await rt.dispose()
    } finally {
      cleanup()
    }
  }, 20000)

  it("request forwarding captures directory/sessionId via PrivateObservationService fake host", async () => {
    const ctrl = new ObservationController({
      getSnapshot: async () => ({ cursor: 0, snapshot: null }),
      readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
      ack: async () => {},
      get: async (input) => {
        expect(input.directory).toBe("/tmp/ws")
        expect(input.sessionId).toBe("ses_fwd")
        return { v: "1.0", status: "not_found" }
      },
    })
    const aToB = new PassThrough()
    const bToA = new PassThrough()
    const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
    const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
    const res = (await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: "/tmp/ws", sessionId: "ses_fwd" })) as { v: string }
    expect(res.v).toBe("1.0")
    client.dispose()
    server.dispose()
  })
})
