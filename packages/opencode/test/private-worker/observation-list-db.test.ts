import { describe, it, expect } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { createSessionListDeps } from "../../src/private-worker/session-list-adapter"
import { encodeGlobalListCursor, decodeGlobalListCursor } from "../../src/session/global-cursor"
import { ObservationController, OBSERVATION_METHODS, OBSERVATION_VERSION } from "../../src/private-worker/observation"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ErrorCode } from "../../src/private-worker/json-rpc"

function tmpDb(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-list-db-"))
  const file = path.join(dir, "kilo.db")
  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
  return { file, cleanup }
}

async function withRuntime(file: string, fn: (db: Database.Interface["db"]) => Promise<void>): Promise<void> {
  const layer = Database.layerNoLease(file)
  const runtime = ManagedRuntime.make(layer)
  const svc = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* Database.Service
    }),
  )
  try {
    await fn(svc.db)
  } finally {
    await runtime.dispose()
  }
}

async function insertSessions(
  db: Database.Interface["db"],
  rows: Array<{ id: string; directory: string; title: string; parent_id?: string | null; updated: number; created: number }>,
): Promise<void> {
  const projectId = "proj_list"
  await Effect.runPromise(
    db
      .insert(ProjectTable)
      .values({
        id: projectId as unknown as string,
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
  for (const r of rows) {
    await Effect.runPromise(
      db
        .insert(SessionTable)
        .values({
          id: r.id as unknown as string,
          project_id: projectId as unknown as string,
          slug: `slug-${r.id}`,
          directory: r.directory,
          title: r.title,
          version: "1",
          parent_id: (r.parent_id ?? null) as unknown as string,
          time_created: r.created,
          time_updated: r.updated,
        } as never)
        .run()
        .pipe(Effect.orDie),
    )
  }
}

describe("observation/list DB-backed pagination/order/cursor and projection (real DB, no lease)", () => {
  it("ordering updated DESC, id DESC and pagination limit+1 with nextCursor iff truncated", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        await insertSessions(db, [
          { id: "ses_a", directory: "/tmp/ws", title: "a", updated: 100, created: 90 },
          { id: "ses_b", directory: "/tmp/ws", title: "b", updated: 200, created: 190 },
          { id: "ses_c", directory: "/tmp/ws", title: "c", updated: 200, created: 195 },
        ])
        const deps = createSessionListDeps(db)
        const out1 = await deps.list({ limit: 1 })
        expect(out1.entries.length).toBe(1)
        expect(out1.entries[0]!.id).toBe("ses_c")
        expect(out1.nextCursor).toBeDefined()
        const decoded = decodeGlobalListCursor(out1.nextCursor!)
        expect(decoded.updated).toBe(200)
        expect(decoded.id).toBe("ses_c")
        const out2 = await deps.list({ cursor: out1.nextCursor!, limit: 1 })
        expect(out2.entries.length).toBe(1)
        expect(out2.entries[0]!.id).toBe("ses_b")
        expect(out2.nextCursor).toBeDefined()
        const out3 = await deps.list({ cursor: out2.nextCursor!, limit: 1 })
        expect(out3.entries.length).toBe(1)
        expect(out3.entries[0]!.id).toBe("ses_a")
        expect(out3.nextCursor).toBeUndefined()
      })
    } finally {
      cleanup()
    }
  })

  it("tie group with same updated paginates without omission via id DESC", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const pinned = 1700000000000
        await insertSessions(db, [
          { id: "ses_1", directory: "/tmp/ws", title: "t1", updated: pinned, created: pinned },
          { id: "ses_2", directory: "/tmp/ws", title: "t2", updated: pinned, created: pinned },
          { id: "ses_3", directory: "/tmp/ws", title: "t3", updated: pinned, created: pinned },
        ])
        const deps = createSessionListDeps(db)
        const page1 = await deps.list({ limit: 2 })
        expect(page1.entries.length).toBe(2)
        expect(page1.entries.map((e) => e.id)).toEqual(["ses_3", "ses_2"])
        expect(page1.nextCursor).toBeDefined()
        const page2 = await deps.list({ cursor: page1.nextCursor!, limit: 2 })
        expect(page2.entries.length).toBe(1)
        expect(page2.entries[0]!.id).toBe("ses_1")
        expect(page2.nextCursor).toBeUndefined()
        const union = [...page1.entries, ...page2.entries].map((e) => e.id).sort()
        expect(union).toEqual(["ses_1", "ses_2", "ses_3"])
      })
    } finally {
      cleanup()
    }
  })

  it("projection minimal and parentID null normalized, no redundant truncated", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        await insertSessions(db, [
          { id: "ses_parent", directory: "/tmp/ws", title: "parent", updated: 300, created: 250 },
          { id: "ses_child", directory: "/tmp/ws", title: "child", parent_id: "ses_parent", updated: 400, created: 350 },
        ])
        const deps = createSessionListDeps(db)
        const out = await deps.list({ limit: 10 })
        expect(out.v).toBe("1.0")
        expect(out.entries.length).toBe(2)
        const child = out.entries.find((e) => e.id === "ses_child")!
        const parent = out.entries.find((e) => e.id === "ses_parent")!
        expect(child.parentID).toBe("ses_parent")
        expect(parent.parentID).toBeNull()
        for (const e of out.entries) {
          expect(Object.keys(e).sort()).toEqual(["createdAt", "directory", "id", "parentID", "title", "updatedAt"])
          expect(typeof e.createdAt).toBe("number")
          expect(typeof e.updatedAt).toBe("number")
        }
        expect((out as unknown as Record<string, unknown>).truncated).toBeUndefined()
        expect(out.nextCursor).toBeUndefined()
      })
    } finally {
      cleanup()
    }
  })

  it("controller delegates to DB adapter and respects limit bounds via wire", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        await insertSessions(db, [
          { id: "ses_x", directory: "/tmp/ws", title: "x", updated: 10, created: 5 },
          { id: "ses_y", directory: "/tmp/ws", title: "y", updated: 20, created: 15 },
        ])
        const base = createSessionListDeps(db)
        const ctrl = new ObservationController({
          getSnapshot: async () => ({ cursor: 0, snapshot: null }),
          readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
          ack: async () => {},
          list: base.list,
        })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const res = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", limit: 1 })) as { entries: unknown[]; nextCursor?: string }
        expect(res.entries.length).toBe(1)
        expect(res.nextCursor).toBeDefined()
        try {
          await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", limit: 0 })
          expect(false).toBe(true)
        } catch (e) {
          expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
        }
        try {
          await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", limit: 501 })
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
})
