import { describe, it, expect } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { createSessionOperationsDeps } from "../../src/private-worker/session-operations-adapter"
import { ObservationController, OBSERVATION_METHODS } from "../../src/private-worker/observation"
import { canonicalDirectory } from "../../src/kilocode/session/canonical-directory"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"

function tmpDb(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-op-fork-"))
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
  const svc = await runtime.runPromise(Effect.gen(function* () { return yield* Database.Service }))
  try {
    await fn(svc.db)
  } finally {
    await runtime.dispose()
  }
}

async function ensureProject(db: Database.Interface["db"]) {
  await Effect.runPromise(
    db
      .insert(ProjectTable)
      .values({ id: "proj_fork" as never, worktree: "/tmp/ws" as never, vcs: "git" as never, time_created: 1, time_updated: 1, sandboxes: [] as never } as never)
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )
}

async function insertSession(db: Database.Interface["db"], id: string, directory: string, parentId: string | null = null) {
  await Effect.runPromise(
    db
      .insert(SessionTable)
      .values({ id: id as never, project_id: "proj_fork" as never, slug: `slug-${id}`, directory: canonicalDirectory(directory) as never, title: `title-${id}`, version: "1", parent_id: parentId as never, time_created: 10, time_updated: 20 } as never)
      .run()
      .pipe(Effect.orDie),
  )
}

async function insertForkOp(
  db: Database.Interface["db"],
  row: { op_id: string; session_id: string; outcome: string; code: string; message: string; time: number; title?: string | null; snapshot?: unknown },
) {
  const snapJson = row.snapshot !== undefined ? JSON.stringify(row.snapshot) : null
  await Effect.runPromise(
    db
      .insert(SessionOperationTable)
      .values({
        op_id: row.op_id as never,
        session_id: row.session_id as never,
        op_kind: "fork" as never,
        outcome: row.outcome as never,
        code: row.code as never,
        message: row.message as never,
        time: row.time as never,
        cancel: null as never,
        detail: "secret detail token=xyz" as never,
        stack: "trace password=123" as never,
        revision: 0 as never,
        idempotency_hash: row.op_id as never,
        request_id: "req-fork" as never,
        directory: canonicalDirectory("/tmp/ws") as never,
        message_id: null as never,
        parent_session_id: null as never,
        title: (row.title ?? null) as never,
        result_snapshot: snapJson as never,
      } as never)
      .run()
      .pipe(Effect.orDie),
  )
}

describe("observation/operation fork exact (real SQLite)", () => {
  it("fork:<source>:<token> exact is panel-safe with strictly validated child reference", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_fork_src", dir)
        await insertSession(db, "ses_fork_child", dir, "ses_fork_src")
        await insertForkOp(db, {
          op_id: "fork:ses_fork_src:tok1",
          session_id: "ses_fork_src",
          outcome: "succeeded",
          code: "fork.succeeded",
          message: "fork succeeded",
          time: 11,
          title: "ses_fork_child",
          snapshot: { id: "ses_fork_child", parent_id: "ses_fork_src", directory: dir },
        })
        const deps = createSessionOperationsDeps(db)
        const out = await deps.operation({ directory: dir, sessionId: "ses_fork_src", opId: "fork:ses_fork_src:tok1" })
        expect(out.status).toBe("found")
        if (out.status !== "found") throw new Error("expected found")
        expect(out.operation.opId).toBe("fork:ses_fork_src:tok1")
        expect(out.operation.outcome).toBe("succeeded")
        expect(new Set(Object.keys(out.operation))).toEqual(new Set(["opId", "outcome", "code", "message", "time", "forkedSessionId"]))
        expect((out.operation as unknown as Record<string, unknown>).forkedSessionId).toBe("ses_fork_child")
        expect("detail" in out.operation).toBe(false)
        expect("recovery" in out.operation).toBe(false)

        const ctrl = new ObservationController({
          getSnapshot: async () => ({ cursor: 0, snapshot: null }),
          readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
          ack: async () => {},
          operations: deps.operations,
          operation: deps.operation,
        })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const via = (await client.request(OBSERVATION_METHODS.OPERATION, { v: "1.0", directory: dir, sessionId: "ses_fork_src", opId: "fork:ses_fork_src:tok1" })) as typeof out
        expect(via).toEqual(out)
        for (const badOp of ["create:tok1", "delete:ses_fork_src:tok1", "fork:ses_fork_src"]) {
          let bad = false
          try {
            await client.request(OBSERVATION_METHODS.OPERATION, { v: "1.0", directory: dir, sessionId: "ses_fork_src", opId: badOp })
          } catch {
            bad = true
          }
          expect(bad).toBe(true)
        }
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })

  it("cross-parent op is scope_mismatch and cross-directory is scope_mismatch", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_fork_a", dir)
        await insertSession(db, "ses_fork_b", dir)
        await insertSession(db, "ses_fork_b_child", dir, "ses_fork_b")
        await insertForkOp(db, {
          op_id: "fork:ses_fork_b:tok9",
          session_id: "ses_fork_b",
          outcome: "succeeded",
          code: "fork.succeeded",
          message: "fork succeeded",
          time: 12,
          title: "ses_fork_b_child",
          snapshot: { id: "ses_fork_b_child", parent_id: "ses_fork_b", directory: dir },
        })
        const deps = createSessionOperationsDeps(db)
        const cross = await deps.operation({ directory: dir, sessionId: "ses_fork_a", opId: "fork:ses_fork_b:tok9" })
        expect(cross.status).toBe("scope_mismatch")
        const otherDir = await deps.operation({ directory: canonicalDirectory("/tmp/other"), sessionId: "ses_fork_b", opId: "fork:ses_fork_b:tok9" })
        expect(otherDir.status).toBe("scope_mismatch")
      })
    } finally {
      cleanup()
    }
  })

  it("invalid snapshot omits child reference but stays panel-safe", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_fork_bad", dir)
        await insertSession(db, "ses_fork_bad_child", dir, "ses_fork_bad")
        await insertForkOp(db, {
          op_id: "fork:ses_fork_bad:tokX",
          session_id: "ses_fork_bad",
          outcome: "succeeded",
          code: "fork.succeeded",
          message: "fork succeeded",
          time: 13,
          title: "ses_fork_bad_child",
          snapshot: { id: "ses_fork_bad_child", parent_id: "ses_other_parent", directory: dir },
        })
        await insertSession(db, "ses_fork_nomatch", dir)
        await insertForkOp(db, {
          op_id: "fork:ses_fork_nomatch:tokY",
          session_id: "ses_fork_nomatch",
          outcome: "succeeded",
          code: "fork.succeeded",
          message: "fork succeeded",
          time: 14,
          title: "ses_wrong_title",
          snapshot: { id: "ses_fork_bad_child", parent_id: "ses_fork_nomatch", directory: dir },
        })
        const deps = createSessionOperationsDeps(db)
        const badParent = await deps.operation({ directory: dir, sessionId: "ses_fork_bad", opId: "fork:ses_fork_bad:tokX" })
        expect(badParent.status).toBe("found")
        if (badParent.status !== "found") throw new Error("expected found")
        expect("forkedSessionId" in badParent.operation).toBe(false)
        expect(new Set(Object.keys(badParent.operation))).toEqual(new Set(["opId", "outcome", "code", "message", "time"]))
        const titleMismatch = await deps.operation({ directory: dir, sessionId: "ses_fork_nomatch", opId: "fork:ses_fork_nomatch:tokY" })
        expect(titleMismatch.status).toBe("found")
        if (titleMismatch.status !== "found") throw new Error("expected found")
        expect("forkedSessionId" in titleMismatch.operation).toBe(false)
      })
    } finally {
      cleanup()
    }
  })
})
