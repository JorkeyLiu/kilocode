import { describe, expect, it } from "bun:test"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PassThrough } from "stream"
import { PrivateObservationService } from "../../src/private-worker/private-observation-service"
import { OBSERVATION_METHODS, OBSERVATION_VERSION, ObservationController } from "../../src/private-worker/observation"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import { JsonRpcPeer } from "../../src/private-worker/peer"

function tmpEnv(): { dbPath: string; xdg: Record<string, string>; cleanup: () => Promise<void> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-msg-"))
  const data = path.join(tmp, "data")
  fs.mkdirSync(data, { recursive: true })
  const dbPath = path.join(data, "kilo.db")
  const xdg = {
    XDG_DATA_HOME: path.join(tmp, "xdg-data"),
    XDG_CONFIG_HOME: path.join(tmp, "xdg-config"),
    XDG_CACHE_HOME: path.join(tmp, "xdg-cache"),
    XDG_STATE_HOME: path.join(tmp, "xdg-state"),
  }
  for (const v of Object.values(xdg)) fs.mkdirSync(v, { recursive: true })
  return { dbPath, xdg, cleanup: async () => fs.rmSync(tmp, { recursive: true, force: true }) }
}

function tmpDb(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-msg-mirror-"))
  return { dir, file: path.join(dir, "kilo.db") }
}

async function expectCode(promise: Promise<unknown>, code: number): Promise<void> {
  try {
    await promise
  } catch (e) {
    expect((e as { code?: number }).code).toBe(code)
    return
  }
  expect(false).toBe(true)
}

describe("PrivateObservationService.messages mirror", () => {
  it("gate-off and disposed reject Not started", async () => {
    const { dbPath, xdg, cleanup } = tmpEnv()
    const svc = new PrivateObservationService({ enabled: false, dbPath, env: xdg })
    try {
      expect(svc.isEnabled()).toBe(false)
      const failed = await svc.messages({ directory: "/tmp/ws", sessionId: "ses_a", limit: 10 }).then(
        () => false,
        (e: Error) => String(e.message).includes("Not started"),
      )
      expect(failed).toBe(true)
    } finally {
      svc.dispose()
      await cleanup()
    }
    const svc2 = new PrivateObservationService({ enabled: false, dbPath: "/tmp/fake.db" })
    svc2.dispose()
    const failed2 = await svc2.messages({ directory: "/tmp/ws", sessionId: "ses_a", limit: 10 }).then(
      () => false,
      () => true,
    )
    expect(failed2).toBe(true)
  })

  it("forwarding captures versioned payload and validates via fake host", async () => {
    const captured: Record<string, unknown> = {}
    const fakeHost = {
      request: async (_m: string, params: unknown) => {
        Object.assign(captured, params as Record<string, unknown>)
        return { v: "1.0", status: "not_found" }
      },
    } as unknown as import("../../src/private-worker/host").PrivateWorkerHost
    const svc = new PrivateObservationService({ enabled: true, dbPath: "/tmp/fake.db" })
    try {
      ;(svc as unknown as { host: unknown }).host = fakeHost
      const res = (await svc.messages({ directory: "/tmp/ws", sessionId: "ses_fwd", limit: 5 })) as { status: string }
      expect(res.status).toBe("not_found")
      expect(captured.v).toBe("1.0")
      expect(captured.directory).toBe("/tmp/ws")
      expect(captured.sessionId).toBe("ses_fwd")
      expect(captured.limit).toBe(5)
      expect("cursor" in captured).toBe(false)
      await svc.messages({ directory: "/tmp/ws", sessionId: "ses_fwd", limit: 5, cursor: "Y3Vyc29y" })
      expect(captured.cursor).toBe("Y3Vyc29y")
    } finally {
      svc.dispose()
    }
  })

  it("real DB page through peer via service with exact owner cleanup", async () => {
    const { dbPath, xdg, cleanup } = tmpEnv()
    const standaloneTs = path.resolve(process.cwd(), "src/private-worker/standalone-worker.ts")
    const svc = new PrivateObservationService({ enabled: true, dbPath, env: xdg, command: "bun", args: ["--conditions=browser", standaloneTs], initializeTimeoutMs: 8000 })
    const { Database } = await import("@opencode-ai/core/database/database")
    const { SessionTable, MessageTable, PartTable } = await import("@opencode-ai/core/session/sql")
    const { ProjectTable } = await import("@opencode-ai/core/project/sql")
    const { Effect, ManagedRuntime } = await import("effect")
    const layer = Database.layerNoLease(dbPath)
    const rt = ManagedRuntime.make(layer)
    try {
      await svc.initialize()
      expect(svc.isStarted()).toBe(true)
      const nf = (await svc.messages({ directory: "/tmp/ws", sessionId: "ses_missing_m", limit: 10 })) as { status: string }
      expect(nf.status).toBe("not_found")
      await expectCode(svc.messages({ directory: "/tmp/ws", sessionId: "ses_a", limit: 0 }), ErrorCode.InvalidParams)
      const db = await rt.runPromise(Effect.gen(function* () { return (yield* Database.Service).db }))
      await Effect.runPromise(db.insert(ProjectTable).values({ id: "proj_vs_msg" as never, worktree: "/tmp/ws" as never, vcs: "git" as never, time_created: 1, time_updated: 1, sandboxes: [] as never } as never).onConflictDoNothing().run().pipe(Effect.orDie))
      await Effect.runPromise(db.insert(SessionTable).values({ id: "ses_vs_msg" as never, project_id: "proj_vs_msg" as never, slug: "s", directory: "/tmp/ws", title: "t", version: "1", parent_id: null as never, time_created: 1, time_updated: 2 } as never).run().pipe(Effect.orDie))
      await Effect.runPromise(db.insert(MessageTable).values({ id: "msg_vs1" as never, session_id: "ses_vs_msg" as never, time_created: 100, time_updated: 100, data: { role: "user", time: { created: 100 }, agent: "a", model: { providerID: "p", modelID: "m" } } as never } as never).run().pipe(Effect.orDie))
      await Effect.runPromise(db.insert(PartTable).values({ id: "prt_vs1" as never, message_id: "msg_vs1" as never, session_id: "ses_vs_msg" as never, time_created: 1, time_updated: 1, data: { type: "text", text: "hi" } as never } as never).run().pipe(Effect.orDie))
      const found = (await svc.messages({ directory: "/tmp/ws", sessionId: "ses_vs_msg", limit: 10 })) as { v: string; status: string; messages: Array<{ info: { id: string }; parts: unknown[] }> }
      expect(found.v).toBe(OBSERVATION_VERSION)
      expect(found.status).toBe("found")
      expect(found.messages.map((m) => m.info.id)).toEqual(["msg_vs1"])
      expect(found.messages[0]!.parts.length).toBe(1)
      const sm = (await svc.messages({ directory: "/tmp/other", sessionId: "ses_vs_msg", limit: 10 })) as { status: string }
      expect(sm.status).toBe("scope_mismatch")
    } finally {
      const host = svc.getHost()
      svc.dispose()
      if (host) await host.waitForExit(2000).then(() => undefined, () => undefined)
      expect(svc.getHost()).toBeNull()
      await rt.dispose()
      await cleanup()
    }
  }, 20000)

  it("mirror adapter: tie order, multi-page, parts, stripping, legacy, malformed, archived/scope/symlink", async () => {
    const { createSessionMessagesDeps } = await import("../../src/private-worker/session-messages-adapter")
    const { canonicalDirectory } = await import("../../src/private-worker/canonical-directory")
    const { Database } = await import("@opencode-ai/core/database/database")
    const { Effect, ManagedRuntime } = await import("effect")
    const { dir, file } = tmpDb()
    const layer = Database.layerNoLease(file)
    const rt = ManagedRuntime.make(layer)
    const peers: JsonRpcPeer[] = []
    try {
      const db = await rt.runPromise(Effect.gen(function* () { return (yield* Database.Service).db }))
      const { SessionTable, MessageTable, PartTable } = await import("@opencode-ai/core/session/sql")
      const { ProjectTable } = await import("@opencode-ai/core/project/sql")
      const { encodeMessageCursor } = await import("@opencode-ai/core/session/message-read")
      const insertProject = () =>
        Effect.runPromise(db.insert(ProjectTable).values({ id: "proj_vsm" as never, worktree: "/tmp/ws" as never, vcs: "git" as never, time_created: 1, time_updated: 1, sandboxes: [] as never } as never).onConflictDoNothing().run().pipe(Effect.orDie))
      const insertSession = (id: string, directory: string, archived: number | null = null) =>
        Effect.runPromise(db.insert(SessionTable).values({ id: id as never, project_id: "proj_vsm" as never, slug: `s-${id}`, directory: canonicalDirectory(directory) as never, title: `t-${id}`, version: "1", parent_id: null as never, time_created: 10, time_updated: 20, time_archived: archived as never, agent: null as never } as never).run().pipe(Effect.orDie))
      const insertMessage = (id: string, sessionId: string, time: number, data?: Record<string, unknown>) =>
        Effect.runPromise(db.insert(MessageTable).values({ id: id as never, session_id: sessionId as never, time_created: time, time_updated: time, data: (data ?? { role: "user", time: { created: time }, agent: "a", model: { providerID: "p", modelID: "m" } }) as never } as never).run().pipe(Effect.orDie))
      const insertPart = (id: string, sessionId: string, messageId: string, data: Record<string, unknown> = { type: "text", text: `t-${id}` }) =>
        Effect.runPromise(db.insert(PartTable).values({ id: id as never, message_id: messageId as never, session_id: sessionId as never, time_created: 1, time_updated: 1, data: data as never } as never).run().pipe(Effect.orDie))
      const wdir = canonicalDirectory("/tmp/ws")
      await insertProject()
      await insertSession("ses_vpag", wdir)
      await insertMessage("msg_001", "ses_vpag", 100)
      await insertMessage("msg_002", "ses_vpag", 100)
      await insertMessage("msg_003", "ses_vpag", 200)
      await insertPart("prt_001", "ses_vpag", "msg_001")
      await insertPart("prt_002", "ses_vpag", "msg_001")
      await insertPart("prt_003", "ses_vpag", "msg_002")
      const deps = createSessionMessagesDeps(db)
      const p1 = await deps.messages({ directory: wdir, sessionId: "ses_vpag", limit: 2 })
      if (p1.status !== "found") throw new Error("expected found")
      expect(p1.messages.map((m) => (m.info as { id: string }).id)).toEqual(["msg_002", "msg_003"])
      const p2 = await deps.messages({ directory: wdir, sessionId: "ses_vpag", limit: 2, cursor: p1.nextCursor })
      if (p2.status !== "found") throw new Error("expected found")
      expect(p2.messages.map((m) => (m.info as { id: string }).id)).toEqual(["msg_001"])
      expect(p2.nextCursor).toBeUndefined()
      expect(new Set([...p1.messages, ...p2.messages].map((m) => (m.info as { id: string }).id)).size).toBe(3)
      expect(p2.messages[0]!.parts.map((x) => (x as { id: string }).id)).toEqual(["prt_001", "prt_002"])
      const ctrl = new ObservationController({ getSnapshot: async () => ({ cursor: 0, snapshot: null }), readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }), ack: async () => {}, messages: deps.messages })
      const wire = async (params: unknown) => {
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        peers.push(client, server)
        return client.request(OBSERVATION_METHODS.MESSAGES, params)
      }
      const via = (await wire({ v: "1.0", directory: wdir, sessionId: "ses_vpag", limit: 10 })) as typeof p1
      if (via.status !== "found") throw new Error("expected found")
      expect(via.messages.map((m) => (m.info as { id: string }).id)).toEqual(["msg_001", "msg_002", "msg_003"])
      // stripping + legacy preservation
      await insertSession("ses_vstrip", wdir)
      await insertMessage("msg_v030", "ses_vstrip", 70, { role: "user", time: { created: 70 }, agent: "a", model: { providerID: "p", modelID: "m" }, variant: "legacy-user-variant" })
      const big = "x".repeat(300 * 1024)
      await insertPart("prt_v030", "ses_vstrip", "msg_v030", { type: "tool", callID: "c", tool: "edit", state: { status: "completed", input: {}, output: "ok", title: "t", metadata: { filediff: { file: "a", patch: big, before: "b", after: "a" } }, time: { start: 0, end: 1 } }, legacyTop: "keep" } as unknown as Record<string, unknown>)
      const stripped = await deps.messages({ directory: wdir, sessionId: "ses_vstrip", limit: 10 })
      if (stripped.status !== "found") throw new Error("expected found")
      expect((stripped.messages[0]!.info as unknown as Record<string, unknown>).variant).toBe("legacy-user-variant")
      const tool = stripped.messages[0]!.parts[0] as unknown as { state: { metadata: { filediff: { patch?: string } } } } & Record<string, unknown>
      expect(tool.state.metadata.filediff.patch).toBeUndefined()
      expect(tool["legacyTop"]).toBe("keep")
      // malformed rows
      await insertSession("ses_vbad", wdir)
      await Effect.runPromise(db.insert(MessageTable).values({ id: "msg_vbad" as never, session_id: "ses_vbad" as never, time_created: 1, time_updated: 1, data: { role: "user" } as never } as never).run().pipe(Effect.orDie))
      await expectCode(deps.messages({ directory: wdir, sessionId: "ses_vbad", limit: 10 }), ErrorCode.InternalError)
      await insertSession("ses_vbadp", wdir)
      await insertMessage("msg_vbap", "ses_vbadp", 5)
      await Effect.runPromise(db.insert(PartTable).values({ id: "prt_vbad" as never, message_id: "msg_vbap" as never, session_id: "ses_vbadp" as never, time_created: 1, time_updated: 1, data: { type: "text" } as never } as never).run().pipe(Effect.orDie))
      await expectCode(deps.messages({ directory: wdir, sessionId: "ses_vbadp", limit: 10 }), ErrorCode.InternalError)
      // stale input cursor still yields a coherent fresh page (anchor matches output)
      const stale = encodeMessageCursor({ id: "msg_zzz", time: 100 })
      const stalePage = (await wire({ v: "1.0", directory: wdir, sessionId: "ses_vpag", limit: 1, cursor: stale })) as {
        status: string
        messages: Array<{ info: { id: string; time: { created: number } } }>
        nextCursor?: string
      }
      expect(stalePage.status).toBe("found")
      // mismatched output cursor via fake deps must reject
      const fakeCtrl = new ObservationController({
        getSnapshot: async () => ({ cursor: 0, snapshot: null }),
        readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
        ack: async () => {},
        messages: async () => ({ v: "1.0", status: "found", messages: via.messages.slice(0, 2) as never, nextCursor: stale }),
      })
      const fToB = new PassThrough()
      const fBack = new PassThrough()
      const fServer = new JsonRpcPeer({ reader: fToB, writer: fBack, onRequest: (m, p) => fakeCtrl.handle(m, p) })
      const fClient = new JsonRpcPeer({ reader: fBack, writer: fToB })
      peers.push(fClient, fServer)
      await expectCode(fClient.request(OBSERVATION_METHODS.MESSAGES, { v: "1.0", directory: wdir, sessionId: "ses_vpag", limit: 2 }), ErrorCode.InternalError)
      // archived / scope / symlink
      await insertSession("ses_varch", wdir, Date.now())
      expect((await deps.messages({ directory: wdir, sessionId: "ses_varch", limit: 10 })).status).toBe("found")
      expect((await deps.messages({ directory: canonicalDirectory("/tmp/other"), sessionId: "ses_vpag", limit: 10 })).status).toBe("scope_mismatch")
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-sym-"))
      try {
        const target = path.join(base, "t")
        fs.mkdirSync(target, { recursive: true })
        const link = path.join(base, "l")
        const linked = (() => {
          try {
            fs.symlinkSync(target, link, "dir")
            return true
          } catch {
            return false
          }
        })()
        if (linked) {
          const dirLink = canonicalDirectory(link)
          const dirTarget = canonicalDirectory(target)
          expect(dirLink).not.toBe(dirTarget)
          await insertSession("ses_vlinkm", dirLink)
          expect((await deps.messages({ directory: target, sessionId: "ses_vlinkm", limit: 10 })).status).toBe("scope_mismatch")
        }
      } finally {
        fs.rmSync(base, { recursive: true, force: true })
      }
    } finally {
      for (const peer of peers) peer.dispose()
      await rt.dispose()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 15000)
})
