import { describe, expect, it } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { PassThrough } from "stream"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { createSessionMessagesDeps } from "../../src/private-worker/session-messages-adapter"
import { ObservationController, OBSERVATION_METHODS } from "../../src/private-worker/observation"
import { canonicalDirectory } from "../../src/kilocode/session/canonical-directory"
import { encodeMessageCursor } from "@opencode-ai/core/session/message-read"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import { sql } from "drizzle-orm"

function tmpDb(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-msg-db-"))
  const file = path.join(dir, "kilo.db")
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

async function withRuntime(file: string, fn: (db: Database.Interface["db"]) => Promise<void>): Promise<void> {
  const layer = Database.layerNoLease(file)
  const runtime = ManagedRuntime.make(layer)
  const svc = await runtime.runPromise(Effect.gen(function* () { return yield* Database.Service }))
  try {
    await fn(svc.db)
  } finally {
    await runtime.dispose()
  }
}

const proj = "proj_msg_db"

async function ensureProject(db: Database.Interface["db"]): Promise<void> {
  await Effect.runPromise(
    db.insert(ProjectTable).values({ id: proj as never, worktree: "/tmp/ws" as never, vcs: "git" as never, time_created: 1, time_updated: 1, sandboxes: [] as never } as never).onConflictDoNothing().run().pipe(Effect.orDie),
  )
}

async function insertSession(db: Database.Interface["db"], id: string, dir: string, archived: number | null = null): Promise<void> {
  await Effect.runPromise(
    db.insert(SessionTable).values({ id: id as never, project_id: proj as never, slug: `s-${id}`, directory: canonicalDirectory(dir) as never, title: `t-${id}`, version: "1", parent_id: null as never, time_created: 10, time_updated: 20, time_archived: archived as never, agent: null as never } as never).run().pipe(Effect.orDie),
  )
}

function userData(time: number): Record<string, unknown> {
  return { role: "user", time: { created: time }, agent: "a", model: { providerID: "p", modelID: "m" } }
}

async function insertMessage(db: Database.Interface["db"], id: string, sessionId: string, time: number, data: Record<string, unknown> = userData(time)): Promise<void> {
  await Effect.runPromise(
    db.insert(MessageTable).values({ id: id as never, session_id: sessionId as never, time_created: time, time_updated: time, data: data as never } as never).run().pipe(Effect.orDie),
  )
}

async function insertPart(db: Database.Interface["db"], id: string, sessionId: string, messageId: string, data: Record<string, unknown> = { type: "text", text: `t-${id}` }): Promise<void> {
  await Effect.runPromise(
    db.insert(PartTable).values({ id: id as never, message_id: messageId as never, session_id: sessionId as never, time_created: 1, time_updated: 1, data: data as never } as never).run().pipe(Effect.orDie),
  )
}

describe("observation/messages DB adapter (real layerNoLease)", () => {
  it("orders, ties, paginates without duplicates, groups parts", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_pag", dir)
        await insertMessage(db, "msg_001", "ses_pag", 100)
        await insertMessage(db, "msg_002", "ses_pag", 100)
        await insertMessage(db, "msg_003", "ses_pag", 200)
        await insertPart(db, "prt_001", "ses_pag", "msg_001")
        await insertPart(db, "prt_002", "ses_pag", "msg_001")
        await insertPart(db, "prt_003", "ses_pag", "msg_002")
        const deps = createSessionMessagesDeps(db)
        const p1 = await deps.messages({ directory: dir, sessionId: "ses_pag", limit: 2 })
        expect(p1.status).toBe("found")
        if (p1.status !== "found") throw new Error("x")
        expect(p1.messages.map((m) => (m.info as { id: string }).id)).toEqual(["msg_002", "msg_003"])
        expect(p1.nextCursor).toBeDefined()
        const p2 = await deps.messages({ directory: dir, sessionId: "ses_pag", limit: 2, cursor: p1.nextCursor })
        if (p2.status !== "found") throw new Error("x")
        expect(p2.messages.map((m) => (m.info as { id: string }).id)).toEqual(["msg_001"])
        expect(p2.nextCursor).toBeUndefined()
        const all = [...p1.messages, ...p2.messages].map((m) => (m.info as { id: string }).id)
        expect(new Set(all).size).toBe(3)
        const m1 = p2.messages[0]!
        expect(m1.parts.map((x) => (x as { id: string }).id)).toEqual(["prt_001", "prt_002"])
        // via peer chronological ASC
        const ctrl = new ObservationController({ getSnapshot: async () => ({ cursor: 0, snapshot: null }), readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }), ack: async () => {}, messages: deps.messages })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new (await import("../../src/private-worker/peer")).JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m: string, p: unknown) => ctrl.handle(m, p) })
        const client = new (await import("../../src/private-worker/peer")).JsonRpcPeer({ reader: bToA, writer: aToB })
        const via = (await client.request(OBSERVATION_METHODS.MESSAGES, { v: "1.0", directory: dir, sessionId: "ses_pag", limit: 10 })) as typeof p1
        if (via.status !== "found") throw new Error("x")
        expect(via.messages.map((m) => (m.info as { id: string }).id)).toEqual(["msg_001", "msg_002", "msg_003"])
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })

  it("empty session found, missing not_found, wrong dir scope_mismatch, archived found", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        const other = canonicalDirectory("/tmp/other")
        await ensureProject(db)
        await insertSession(db, "ses_empty", dir)
        await insertSession(db, "ses_arch", dir, Date.now())
        const deps = createSessionMessagesDeps(db)
        expect(await deps.messages({ directory: dir, sessionId: "ses_empty", limit: 10 })).toEqual({ v: "1.0", status: "found", messages: [] })
        expect(await deps.messages({ directory: dir, sessionId: "ses_nope", limit: 10 })).toEqual({ v: "1.0", status: "not_found" })
        await insertMessage(db, "msg_010", "ses_empty", 50)
        expect(await deps.messages({ directory: other, sessionId: "ses_empty", limit: 10 })).toEqual({ v: "1.0", status: "scope_mismatch" })
        const arch = await deps.messages({ directory: dir, sessionId: "ses_arch", limit: 10 })
        expect(arch).toEqual({ v: "1.0", status: "found", messages: [] })
      })
    } finally {
      cleanup()
    }
  })

  it("lexical canonical and symlink isolation", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        await ensureProject(db)
        const canon = canonicalDirectory("/tmp/ws/sub")
        await insertSession(db, "ses_lex", canon)
        await insertMessage(db, "msg_020", "ses_lex", 60)
        const deps = createSessionMessagesDeps(db)
        const viaRaw = await deps.messages({ directory: "/tmp/ws/./sub/../sub", sessionId: "ses_lex", limit: 10 })
        expect(viaRaw.status).toBe("found")
        const base = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-msg-sym-"))
        try {
          const target = path.join(base, "t")
          fs.mkdirSync(target, { recursive: true })
          const link = path.join(base, "l")
          let ok = true
          try {
            fs.symlinkSync(target, link, "dir")
          } catch {
            ok = false
          }
          if (ok) {
            const dirLink = canonicalDirectory(link)
            const dirTarget = canonicalDirectory(target)
            expect(dirLink).not.toBe(dirTarget)
            await insertSession(db, "ses_linkm", dirLink)
            const deps2 = createSessionMessagesDeps(db)
            expect((await deps2.messages({ directory: target, sessionId: "ses_linkm", limit: 10 })).status).toBe("scope_mismatch")
          }
        } finally {
          fs.rmSync(base, { recursive: true, force: true })
        }
      })
    } finally {
      cleanup()
    }
  })

  it("stripping applied and corrupt rows reject", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_strip", dir)
        await insertMessage(db, "msg_030", "ses_strip", 70)
        const big = "x".repeat(300 * 1024)
        await insertPart(db, "prt_030", "ses_strip", "msg_030", { type: "tool", callID: "c", tool: "edit", state: { status: "completed", input: {}, output: "ok", title: "t", metadata: { filediff: { file: "a", patch: big, before: "b", after: "a" } }, time: { start: 0, end: 1 } } })
        const deps = createSessionMessagesDeps(db)
        const out = await deps.messages({ directory: dir, sessionId: "ses_strip", limit: 10 })
        if (out.status !== "found") throw new Error("x")
        const tool = out.messages[0]!.parts[0] as unknown as { state: { status: string; metadata: { filediff: { patch?: string } } } }
        expect(tool.state.metadata.filediff.patch).toBeUndefined()
        // corrupt message
        await insertSession(db, "ses_bad", dir)
        await Effect.runPromise(db.insert(MessageTable).values({ id: "msg_bad" as never, session_id: "ses_bad" as never, time_created: 1, time_updated: 1, data: { role: "user" } as never } as never).run().pipe(Effect.orDie))
        try {
          await deps.messages({ directory: dir, sessionId: "ses_bad", limit: 10 })
          expect(false).toBe(true)
        } catch (e) {
          expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
        }
        // corrupt part
        await insertSession(db, "ses_badp", dir)
        await insertMessage(db, "msg_bap", "ses_badp", 5)
        await Effect.runPromise(db.insert(PartTable).values({ id: "prt_bad" as never, message_id: "msg_bap" as never, session_id: "ses_badp" as never, time_created: 1, time_updated: 1, data: { type: "text" } as never } as never).run().pipe(Effect.orDie))
        try {
          await deps.messages({ directory: dir, sessionId: "ses_badp", limit: 10 })
          expect(false).toBe(true)
        } catch (e) {
          expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
        }
        // corrupt cursor via adapter -> InternalError, via peer -> InvalidParams
        const badCursor = "bad!!!"
        try {
          await deps.messages({ directory: dir, sessionId: "ses_strip", limit: 10, cursor: badCursor })
          expect(false).toBe(true)
        } catch (e) {
          expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
        }
        const ctrl = new ObservationController({ getSnapshot: async () => ({ cursor: 0, snapshot: null }), readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }), ack: async () => {}, messages: deps.messages })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const { JsonRpcPeer } = await import("../../src/private-worker/peer")
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m: string, p: unknown) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        try {
          await client.request(OBSERVATION_METHODS.MESSAGES, { v: "1.0", directory: dir, sessionId: "ses_strip", limit: 10, cursor: badCursor })
          expect(false).toBe(true)
        } catch (e) {
          expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
        }
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })

  it("preserves legacy top-level extras while rejecting malformed required fields", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_legacy", dir)
        await insertMessage(db, "msg_leg1", "ses_legacy", 80, {
          ...userData(80),
          variant: "legacy-user-variant",
        })
        await insertPart(db, "prt_leg1", "ses_legacy", "msg_leg1", { type: "text", text: "hi", legacyNote: "keep" })
        const deps = createSessionMessagesDeps(db)
        const out = await deps.messages({ directory: dir, sessionId: "ses_legacy", limit: 10 })
        if (out.status !== "found") throw new Error("x")
        expect((out.messages[0]!.info as unknown as Record<string, unknown>).variant).toBe("legacy-user-variant")
        expect((out.messages[0]!.parts[0] as unknown as Record<string, unknown>).legacyNote).toBe("keep")
      })
    } finally {
      cleanup()
    }
  })
})
