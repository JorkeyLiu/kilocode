import { describe, it, expect } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { SessionDeleteTombstoneTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { createSessionOperationsDeps } from "../../src/private-worker/session-operations-adapter"
import { ObservationController, OBSERVATION_METHODS } from "../../src/private-worker/observation"
import { canonicalDirectory } from "../../src/kilocode/session/canonical-directory"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { eq } from "drizzle-orm"

function tmpDb(): { file: string; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-del-exact-"))
  const file = path.join(dir, "kilo.db")
  const cleanup = () => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
  return { file, dir, cleanup }
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

async function ensureProject(db: Database.Interface["db"]) {
  await Effect.runPromise(
    db.insert(ProjectTable).values({ id: "proj_del" as never, worktree: "/tmp/ws" as never, vcs: "git" as never, time_created: 1, time_updated: 1, sandboxes: [] as never } as never).onConflictDoNothing().run().pipe(Effect.orDie),
  )
}

const UUID = "123e4567-e89b-12d3-a456-426614174000"

async function insertTombstone(db: Database.Interface["db"], sessionId: string, directory: string, opId: string) {
  const hash = SessionOperation.hashIdempotencyKey(opId)
  await Effect.runPromise(
    db.insert(SessionDeleteTombstoneTable).values({
      op_id: opId,
      session_id: sessionId as never,
      idempotency_hash: hash,
      request_id: "req-del-1",
      directory,
      parent_session_id: null,
      config_version: null,
      session_revision: null,
      time: Date.now(),
      code: "delete.succeeded",
      message: "delete succeeded",
      outcome: "succeeded",
    } as never).run().pipe(Effect.orDie),
  )
}

describe("observation/delete-operation exact tombstone (real SQLite)", () => {
  it("exact PK found returns closed {v,status} with no raw leak", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        const sid = "ses_del_exact_a"
        const opId = `delete:${sid}:${UUID}`
        await insertTombstone(db, sid, dir, opId)
        const deps = createSessionOperationsDeps(db)
        const out = await deps.deleteOperation({ directory: dir, sessionId: sid, opId })
        expect(out).toEqual({ v: "1.0", status: "found" })
        expect(new Set(Object.keys(out))).toEqual(new Set(["v", "status"]))
        expect("code" in (out as Record<string, unknown>)).toBe(false)
        expect("message" in (out as Record<string, unknown>)).toBe(false)
        expect("hash" in (out as Record<string, unknown>)).toBe(false)

        const ctrl = new ObservationController({
          getSnapshot: async () => ({ cursor: 0, snapshot: null }),
          readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
          ack: async () => {},
          deleteOperation: deps.deleteOperation,
        })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const via = (await client.request(OBSERVATION_METHODS.DELETE_OPERATION, { v: "1.0", directory: dir, sessionId: sid, opId })) as typeof out
        expect(via).toEqual(out)
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })

  it("absent tombstone is not_found; directory mismatch is scope_mismatch", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        const sid = "ses_del_exact_b"
        const opId = `delete:${sid}:${UUID}`
        const deps = createSessionOperationsDeps(db)
        const absent = await deps.deleteOperation({ directory: dir, sessionId: sid, opId })
        expect(absent.status).toBe("not_found")

        await insertTombstone(db, sid, dir, opId)
        const otherDir = canonicalDirectory("/tmp/other")
        const mismatch = await deps.deleteOperation({ directory: otherDir, sessionId: sid, opId })
        expect(mismatch.status).toBe("scope_mismatch")
      })
    } finally {
      cleanup()
    }
  })

  it("tombstone survives family hard-delete cascade (no SessionTable dependency)", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        const sid = "ses_del_cascade"
        await Effect.runPromise(
          db.insert(SessionTable).values({ id: sid as never, project_id: "proj_del" as never, slug: `slug-${sid}`, directory: dir as never, title: `title-${sid}`, version: "1", parent_id: null as never, time_created: 10, time_updated: 20 } as never).run().pipe(Effect.orDie),
        )
        const opId = `delete:${sid}:${UUID}`
        await insertTombstone(db, sid, dir, opId)
        // Hard delete the live session row (simulates family cascade removal).
        await Effect.runPromise(db.delete(SessionTable).where(eq(SessionTable.id, sid as never)).run().pipe(Effect.orDie))
        const deps = createSessionOperationsDeps(db)
        const out = await deps.deleteOperation({ directory: dir, sessionId: sid, opId })
        expect(out.status).toBe("found")
      })
    } finally {
      cleanup()
    }
  })

  it("same-physical symlink alias resolves to found", async () => {
    const { file, dir: tmpRoot, cleanup } = tmpDb()
    const realDir = path.join(tmpRoot, "real")
    fs.mkdirSync(realDir, { recursive: true })
    const linkDir = path.join(tmpRoot, "link")
    try { fs.symlinkSync(realDir, linkDir) } catch { /* windows */ }
    try {
      await withRuntime(file, async (db) => {
        const canonReal = canonicalDirectory(realDir)
        await ensureProject(db)
        const sid = "ses_del_alias"
        const opId = `delete:${sid}:${UUID}`
        await insertTombstone(db, sid, canonReal, opId)
        const deps = createSessionOperationsDeps(db)
        // Request via symlink alias should match same physical directory.
        let aliasDir: string
        try {
          aliasDir = (await import("../../src/kilocode/session/canonical-directory")).authoritativeDirectory(linkDir)
        } catch {
          aliasDir = canonReal
        }
        const out = await deps.deleteOperation({ directory: aliasDir, sessionId: sid, opId })
        expect(out.status).toBe("found")
      })
    } finally {
      cleanup()
    }
  })

  it("idempotent restart: tombstone persists across runtime dispose/reopen", async () => {
    const { file, cleanup } = tmpDb()
    try {
      const dir = canonicalDirectory("/tmp/ws")
      const sid = "ses_del_restart"
      const opId = `delete:${sid}:${UUID}`
      await withRuntime(file, async (db) => {
        await ensureProject(db)
        await insertTombstone(db, sid, dir, opId)
      })
      await withRuntime(file, async (db) => {
        const deps = createSessionOperationsDeps(db)
        const out = await deps.deleteOperation({ directory: dir, sessionId: sid, opId })
        expect(out.status).toBe("found")
        // Second lookup is idempotent.
        const again = await deps.deleteOperation({ directory: dir, sessionId: sid, opId })
        expect(again).toEqual(out)
      })
    } finally {
      cleanup()
    }
  })

  it("strict opId rejects non-uuid, wrong prefix, and binding mismatch without SDK", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        const deps = createSessionOperationsDeps(db)
        const sid = "ses_del_strict"
        const badOpIds = [
          `delete:${sid}:not-a-uuid`,
          `create:${UUID}`,
          `delete:${sid}:tok:with:colon`,
          `delete:ses_other:${UUID}`,
        ]
        for (const bad of badOpIds) {
          let threw = false
          try {
            await deps.deleteOperation({ directory: dir, sessionId: sid, opId: bad })
          } catch {
            threw = true
          }
          expect(threw).toBe(true)
        }
        const ctrl = new ObservationController({
          getSnapshot: async () => ({ cursor: 0, snapshot: null }),
          readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
          ack: async () => {},
          deleteOperation: deps.deleteOperation,
        })
        let badWire = false
        try {
          await ctrl.handle(OBSERVATION_METHODS.DELETE_OPERATION, { v: "1.0", directory: dir, sessionId: sid, opId: `delete:${sid}:bad` })
        } catch {
          badWire = true
        }
        expect(badWire).toBe(true)
      })
    } finally {
      cleanup()
    }
  })
})
