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
import { canonicalDirectory } from "../../src/kilocode/session/canonical-directory"
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
  rows: Array<{ id: string; directory: string; title: string; parent_id?: string | null; updated: number; created: number; archived?: number | null }>,
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
          directory: canonicalDirectory(r.directory),
          title: r.title,
          version: "1",
          parent_id: (r.parent_id ?? null) as unknown as string,
          time_created: r.created,
          time_updated: r.updated,
          time_archived: (r.archived ?? null) as unknown as number,
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
        const dir = canonicalDirectory("/tmp/ws")
        await insertSessions(db, [
          { id: "ses_a", directory: dir, title: "a", updated: 100, created: 90 },
          { id: "ses_b", directory: dir, title: "b", updated: 200, created: 190 },
          { id: "ses_c", directory: dir, title: "c", updated: 200, created: 195 },
        ])
        const deps = createSessionListDeps(db)
        const out1 = await deps.list({ directory: dir, limit: 1 })
        expect(out1.entries.length).toBe(1)
        expect(out1.entries[0]!.id).toBe("ses_c")
        expect(out1.nextCursor).toBeDefined()
        const decoded = decodeGlobalListCursor(out1.nextCursor!)
        expect(decoded.updated).toBe(200)
        expect(decoded.id).toBe("ses_c")
        const out2 = await deps.list({ directory: dir, cursor: out1.nextCursor!, limit: 1 })
        expect(out2.entries.length).toBe(1)
        expect(out2.entries[0]!.id).toBe("ses_b")
        expect(out2.nextCursor).toBeDefined()
        const out3 = await deps.list({ directory: dir, cursor: out2.nextCursor!, limit: 1 })
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
        const dir = canonicalDirectory("/tmp/ws")
        const pinned = 1700000000000
        await insertSessions(db, [
          { id: "ses_1", directory: dir, title: "t1", updated: pinned, created: pinned },
          { id: "ses_2", directory: dir, title: "t2", updated: pinned, created: pinned },
          { id: "ses_3", directory: dir, title: "t3", updated: pinned, created: pinned },
        ])
        const deps = createSessionListDeps(db)
        const page1 = await deps.list({ directory: dir, limit: 2 })
        expect(page1.entries.length).toBe(2)
        expect(page1.entries.map((e) => e.id)).toEqual(["ses_3", "ses_2"])
        expect(page1.nextCursor).toBeDefined()
        const page2 = await deps.list({ directory: dir, cursor: page1.nextCursor!, limit: 2 })
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
        const dir = canonicalDirectory("/tmp/ws")
        await insertSessions(db, [
          { id: "ses_parent", directory: dir, title: "parent", updated: 300, created: 250 },
          { id: "ses_child", directory: dir, title: "child", parent_id: "ses_parent", updated: 400, created: 350 },
        ])
        const deps = createSessionListDeps(db)
        const out = await deps.list({ directory: dir, limit: 10 })
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

  it("cross-directory isolation", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dirA = canonicalDirectory("/tmp/ws-a")
        const dirB = canonicalDirectory("/tmp/ws-b")
        await insertSessions(db, [
          { id: "ses_a1", directory: dirA, title: "a1", updated: 100, created: 90 },
          { id: "ses_a2", directory: dirA, title: "a2", updated: 200, created: 190 },
          { id: "ses_b1", directory: dirB, title: "b1", updated: 300, created: 290 },
        ])
        const deps = createSessionListDeps(db)
        const outA = await deps.list({ directory: dirA, limit: 10 })
        expect(outA.entries.map((e) => e.id).sort()).toEqual(["ses_a1", "ses_a2"])
        const outB = await deps.list({ directory: dirB, limit: 10 })
        expect(outB.entries.map((e) => e.id)).toEqual(["ses_b1"])
        // ensure no cross leakage via pagination cursor
        const pagedA = await deps.list({ directory: dirA, limit: 1 })
        expect(pagedA.entries[0]!.id).toBe("ses_a2")
        const nextA = await deps.list({ directory: dirA, cursor: pagedA.nextCursor!, limit: 1 })
        expect(nextA.entries[0]!.id).toBe("ses_a1")
        expect(nextA.entries.some((e) => e.id === "ses_b1")).toBe(false)
      })
    } finally {
      cleanup()
    }
  })

  it("default excludes archived, archived=true includes both", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await insertSessions(db, [
          { id: "ses_active", directory: dir, title: "active", updated: 100, created: 90 },
          { id: "ses_archived", directory: dir, title: "archived", updated: 200, created: 190, archived: Date.now() },
        ])
        const deps = createSessionListDeps(db)
        const def = await deps.list({ directory: dir, limit: 10 })
        expect(def.entries.map((e) => e.id)).toEqual(["ses_active"])
        const withArchived = await deps.list({ directory: dir, archived: true, limit: 10 })
        expect(withArchived.entries.map((e) => e.id).sort()).toEqual(["ses_active", "ses_archived"])
        const explicitFalse = await deps.list({ directory: dir, archived: false, limit: 10 })
        expect(explicitFalse.entries.map((e) => e.id)).toEqual(["ses_active"])
      })
    } finally {
      cleanup()
    }
  })

  it("archived filtering combines with cursor pagination", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await insertSessions(db, [
          { id: "ses_n1", directory: dir, title: "n1", updated: 300, created: 290 },
          { id: "ses_a", directory: dir, title: "arch", updated: 200, created: 190, archived: Date.now() },
          { id: "ses_n2", directory: dir, title: "n2", updated: 100, created: 90 },
        ])
        const deps = createSessionListDeps(db)
        const page1 = await deps.list({ directory: dir, limit: 1 })
        expect(page1.entries[0]!.id).toBe("ses_n1")
        const page2 = await deps.list({ directory: dir, cursor: page1.nextCursor!, limit: 1 })
        expect(page2.entries[0]!.id).toBe("ses_n2")
        expect(page2.nextCursor).toBeUndefined()
        const all = await deps.list({ directory: dir, archived: true, limit: 10 })
        expect(all.entries.length).toBe(3)
      })
    } finally {
      cleanup()
    }
  })

  it("validation failure for absent/relative/empty directory", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const deps = createSessionListDeps(db)
        const bad: Array<Record<string, unknown>> = [
          { limit: 10 } as unknown as Record<string, unknown>,
          { directory: "", limit: 10 },
          { directory: "relative/path", limit: 10 },
          { directory: "./rel", limit: 10 },
        ]
        for (const input of bad) {
          try {
            await deps.list(input as unknown as { directory: string; limit: number })
            expect(false).toBe(true)
          } catch (e) {
            expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
          }
        }
        // controller-level validation also rejects
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
        for (const params of [
          { v: "1.0", limit: 10 },
          { v: "1.0", directory: "", limit: 10 },
          { v: "1.0", directory: "relative/path", limit: 10 },
        ]) {
          try {
            await client.request(OBSERVATION_METHODS.LIST, params)
            expect(false).toBe(true)
          } catch (e) {
            expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
          }
        }
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })

  it("pagination within directory preserves cursor lexicographic ordering", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await insertSessions(db, [
          { id: "ses_1", directory: dir, title: "t1", updated: 100, created: 90 },
          { id: "ses_2", directory: dir, title: "t2", updated: 100, created: 91 },
          { id: "ses_3", directory: dir, title: "t3", updated: 100, created: 92 },
          { id: "ses_4", directory: dir, title: "t4", updated: 200, created: 190 },
        ])
        const deps = createSessionListDeps(db)
        const p1 = await deps.list({ directory: dir, limit: 2 })
        expect(p1.entries.map((e) => e.id)).toEqual(["ses_4", "ses_3"])
        const p2 = await deps.list({ directory: dir, cursor: p1.nextCursor!, limit: 2 })
        expect(p2.entries.map((e) => e.id)).toEqual(["ses_2", "ses_1"])
        expect(p2.nextCursor).toBeUndefined()
      })
    } finally {
      cleanup()
    }
  })

  it("controller delegates to DB adapter and respects limit bounds via wire with directory", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await insertSessions(db, [
          { id: "ses_x", directory: dir, title: "x", updated: 10, created: 5 },
          { id: "ses_y", directory: dir, title: "y", updated: 20, created: 15 },
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
        const res = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: dir, limit: 1 })) as { entries: unknown[]; nextCursor?: string }
        expect(res.entries.length).toBe(1)
        expect(res.nextCursor).toBeDefined()
        try {
          await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: dir, limit: 0 })
          expect(false).toBe(true)
        } catch (e) {
          expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
        }
        try {
          await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: dir, limit: 501 })
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

  it("lexical canonicalization keeps symlink-spelled rows distinct and proves directory+archived+pagination predicates together", async () => {
    const { file, cleanup } = tmpDb()
    // Prepare symlink target and link outside DB
    const baseFs = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-sym-"))
    const target = path.join(baseFs, "target")
    fs.mkdirSync(target, { recursive: true })
    const link = path.join(baseFs, "link")
    let symlinkOk = false
    try {
      fs.symlinkSync(target, link, "dir")
      symlinkOk = true
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS" || (e as Error).message.includes("operation not permitted")) {
        symlinkOk = false
      } else {
        throw e
      }
    }
    const canonLink = canonicalDirectory(link)
    const canonTarget = canonicalDirectory(target)
    const otherDir = canonicalDirectory(path.join(baseFs, "other"))
    // If symlink creation succeeded, lexical distinction must hold
    if (symlinkOk) {
      expect(canonLink).not.toBe(canonTarget)
    }
    try {
      await withRuntime(file, async (db) => {
        const nowArchived = Date.now()
        // Directory A is canonLink if symlinkOk else otherDir fallback for primary directory
        const dirA = symlinkOk ? canonLink : canonicalDirectory(path.join(baseFs, "dirA"))
        const dirB = symlinkOk ? canonTarget : otherDir
        // Use distinct directories when symlink not available
        const primary = dirA
        const secondary = dirB
        await insertSessions(db, [
          { id: "ses_a1", directory: primary, title: "a1", updated: 100, created: 90 },
          { id: "ses_a_arch", directory: primary, title: "a_arch", updated: 200, created: 190, archived: nowArchived },
          { id: "ses_a2", directory: primary, title: "a2", updated: 300, created: 290 },
          { id: "ses_b_newer", directory: secondary, title: "b_newer", updated: 999, created: 990 },
        ])
        const deps = createSessionListDeps(db)
        // Controller double-canonicalization idempotence: wire via controller with raw symlink spelling
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
        const rawPrimary = symlinkOk ? link : primary
        // default excludes archived, directory isolated from newer row in other directory
        const def = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: rawPrimary, limit: 10 })) as { entries: Array<{ id: string }> }
        expect(def.entries.map((e) => e.id).sort()).toEqual(["ses_a1", "ses_a2"])
        // archived:true includes archived rows, still isolated
        const incl = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: rawPrimary, archived: true, limit: 10 })) as { entries: Array<{ id: string }> }
        expect(incl.entries.map((e) => e.id).sort()).toEqual(["ses_a1", "ses_a2", "ses_a_arch"])
        // archived:true pagination limit 1 must paginate within directory only
        const p1 = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: rawPrimary, archived: true, limit: 1 })) as { entries: Array<{ id: string }>; nextCursor?: string }
        expect(p1.entries[0]!.id).toBe("ses_a2")
        expect(p1.nextCursor).toBeDefined()
        const p2 = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: rawPrimary, archived: true, cursor: p1.nextCursor!, limit: 1 })) as { entries: Array<{ id: string }>; nextCursor?: string }
        expect(p2.entries[0]!.id).toBe("ses_a_arch")
        expect(p2.nextCursor).toBeDefined()
        const p3 = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: rawPrimary, archived: true, cursor: p2.nextCursor!, limit: 1 })) as { entries: Array<{ id: string }>; nextCursor?: string }
        expect(p3.entries[0]!.id).toBe("ses_a1")
        expect(p3.nextCursor).toBeUndefined()
        // pagination with default (archived excluded) also isolated
        const q1 = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: rawPrimary, limit: 1 })) as { entries: Array<{ id: string }>; nextCursor?: string }
        expect(q1.entries[0]!.id).toBe("ses_a2")
        const q2 = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: rawPrimary, cursor: q1.nextCursor!, limit: 1 })) as { entries: Array<{ id: string }>; nextCursor?: string }
        expect(q2.entries[0]!.id).toBe("ses_a1")
        expect(q2.nextCursor).toBeUndefined()
        // Other directory query returns only its newer row, not primary rows
        const rawSecondary = symlinkOk ? target : secondary
        const other = (await client.request(OBSERVATION_METHODS.LIST, { v: "1.0", directory: rawSecondary, limit: 10 })) as { entries: Array<{ id: string }> }
        expect(other.entries.map((e) => e.id)).toEqual(["ses_b_newer"])
        // Direct adapter idempotence: calling with already-canonical directory yields same
        const direct1 = await deps.list({ directory: primary, archived: true, limit: 10 })
        const direct2 = await deps.list({ directory: canonicalDirectory(primary), archived: true, limit: 10 })
        expect(direct1.entries.map((e) => e.id).sort()).toEqual(direct2.entries.map((e) => e.id).sort())
        // symlink lexical isolation: if symlinkOk, querying via opposite spelling must not leak
        if (symlinkOk) {
          const viaLink = await deps.list({ directory: link, limit: 10 })
          const viaTarget = await deps.list({ directory: target, limit: 10 })
          expect(viaLink.entries.some((e) => e.id === "ses_b_newer")).toBe(false)
          expect(viaTarget.entries.some((e) => e.id === "ses_a1")).toBe(false)
        }
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
      fs.rmSync(baseFs, { recursive: true, force: true })
    }
  })
})
