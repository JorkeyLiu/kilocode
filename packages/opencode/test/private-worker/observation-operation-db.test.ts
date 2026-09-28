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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-op-exact-"))
  const file = path.join(dir, "kilo.db")
  const cleanup = () => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
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
    db.insert(ProjectTable).values({ id: "proj_exact" as never, worktree: "/tmp/ws" as never, vcs: "git" as never, time_created: 1, time_updated: 1, sandboxes: [] as never } as never).onConflictDoNothing().run().pipe(Effect.orDie),
  )
}

async function insertSession(db: Database.Interface["db"], id: string, directory: string) {
  await Effect.runPromise(
    db.insert(SessionTable).values({ id: id as never, project_id: "proj_exact" as never, slug: `slug-${id}`, directory: canonicalDirectory(directory) as never, title: `title-${id}`, version: "1", parent_id: null as never, time_created: 10, time_updated: 20 } as never).run().pipe(Effect.orDie),
  )
}

async function insertOp(db: Database.Interface["db"], row: { op_id: string; session_id: string; outcome: string; code: string; message: string; time: number; op_kind?: string }) {
  await Effect.runPromise(
    db.insert(SessionOperationTable).values({ op_id: row.op_id as never, session_id: row.session_id as never, op_kind: (row.op_kind ?? "prompt") as never, outcome: row.outcome as never, code: row.code as never, message: row.message as never, time: row.time as never, cancel: null as never, detail: "secret detail token=xyz" as never, stack: "trace password=123" as never, revision: 1 as never, idempotency_hash: null as never, request_id: null as never, directory: null as never, message_id: null as never, parent_session_id: null as never } as never).run().pipe(Effect.orDie),
  )
}

describe("observation/operation exact opId (real SQLite)", () => {
  it("exact PK lookup returns panel-safe entry with no diagnostic leak", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_exact_a", dir)
        await insertOp(db, { op_id: "prompt:msg_exact_a", session_id: "ses_exact_a", outcome: "in-flight", code: "prompt.inflight", message: "prompt accepted", time: 42 })
        const deps = createSessionOperationsDeps(db)
        const out = await deps.operation({ directory: dir, sessionId: "ses_exact_a", opId: "prompt:msg_exact_a" })
        expect(out.status).toBe("found")
        if (out.status !== "found") throw new Error("expected found")
        expect(out.operation.opId).toBe("prompt:msg_exact_a")
        expect(out.operation.outcome).toBe("in-flight")
        expect(new Set(Object.keys(out.operation))).toEqual(new Set(["opId", "outcome", "code", "message", "time"]))
        expect("detail" in out.operation).toBe(false)

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
        const via = (await client.request(OBSERVATION_METHODS.OPERATION, { v: "1.0", directory: dir, sessionId: "ses_exact_a", opId: "prompt:msg_exact_a" })) as typeof out
        expect(via).toEqual(out)
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })

  it("absent op is not_found, cross-session op is scope_mismatch, cross-directory is scope_mismatch", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_exact_b", dir)
        await insertSession(db, "ses_exact_c", dir)
        await insertOp(db, { op_id: "prompt:msg_shared", session_id: "ses_exact_c", outcome: "succeeded", code: "ok", message: "ok", time: 7 })
        const deps = createSessionOperationsDeps(db)
        const absent = await deps.operation({ directory: dir, sessionId: "ses_exact_b", opId: "prompt:msg_missing" })
        expect(absent.status).toBe("not_found")
        const cross = await deps.operation({ directory: dir, sessionId: "ses_exact_b", opId: "prompt:msg_shared" })
        expect(cross.status).toBe("scope_mismatch")
        const otherDir = await deps.operation({ directory: canonicalDirectory("/tmp/other"), sessionId: "ses_exact_b", opId: "prompt:msg_shared" })
        expect(otherDir.status).toBe("scope_mismatch")
      })
    } finally {
      cleanup()
    }
  })

  it("latest-N cannot infer absence but exact can: many rows beyond limit still resolve exact old op", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_exact_d", dir)
        await insertOp(db, { op_id: "prompt:msg_old", session_id: "ses_exact_d", outcome: "succeeded", code: "ok", message: "ok", time: 1 })
        for (let i = 0; i < 5; i += 1) {
          await insertOp(db, { op_id: `prompt:msg_new${i}`, session_id: "ses_exact_d", outcome: "succeeded", code: "ok", message: "ok", time: 100 + i })
        }
        const deps = createSessionOperationsDeps(db)
        const latest = await deps.operations({ directory: dir, sessionId: "ses_exact_d", limit: 1 })
        if (latest.status !== "found") throw new Error("expected found")
        expect(latest.operations[0]!.opId).not.toBe("prompt:msg_old")
        const exact = await deps.operation({ directory: dir, sessionId: "ses_exact_d", opId: "prompt:msg_old" })
        expect(exact.status).toBe("found")
        if (exact.status !== "found") throw new Error("expected found")
        expect(exact.operation.opId).toBe("prompt:msg_old")
      })
    } finally {
      cleanup()
    }
  })

  it("revert/unrevert exact PK succeeded records are panel-safe with no diagnostic leak or recovery", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_exact_r", dir)
        await insertSession(db, "ses_exact_u", dir)
        await insertOp(db, { op_id: "revert:ses_exact_r:tok1", session_id: "ses_exact_r", outcome: "succeeded", code: "revert.succeeded", message: "revert succeeded", time: 11, op_kind: "revert" })
        await insertOp(db, { op_id: "unrevert:ses_exact_u:tok2", session_id: "ses_exact_u", outcome: "succeeded", code: "unrevert.succeeded", message: "unrevert succeeded", time: 12, op_kind: "unrevert" })
        const deps = createSessionOperationsDeps(db)
        const r = await deps.operation({ directory: dir, sessionId: "ses_exact_r", opId: "revert:ses_exact_r:tok1" })
        expect(r.status).toBe("found")
        if (r.status !== "found") throw new Error("expected found")
        expect(r.operation.opId).toBe("revert:ses_exact_r:tok1")
        expect(r.operation.outcome).toBe("succeeded")
        expect(new Set(Object.keys(r.operation))).toEqual(new Set(["opId", "outcome", "code", "message", "time"]))
        expect("detail" in r.operation).toBe(false)
        expect("recovery" in r.operation).toBe(false)
        const u = await deps.operation({ directory: dir, sessionId: "ses_exact_u", opId: "unrevert:ses_exact_u:tok2" })
        expect(u.status).toBe("found")
        if (u.status !== "found") throw new Error("expected found")
        expect(u.operation.opId).toBe("unrevert:ses_exact_u:tok2")
        expect("recovery" in u.operation).toBe(false)
        const cross = await deps.operation({ directory: dir, sessionId: "ses_exact_r", opId: "unrevert:ses_exact_u:tok2" })
        expect(cross.status).toBe("scope_mismatch")
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
        const via = (await client.request(OBSERVATION_METHODS.OPERATION, { v: "1.0", directory: dir, sessionId: "ses_exact_r", opId: "revert:ses_exact_r:tok1" })) as typeof r
        expect(via).toEqual(r)
        let bad = false
        try {
          await client.request(OBSERVATION_METHODS.OPERATION, { v: "1.0", directory: dir, sessionId: "ses_exact_r", opId: "create:tok1" })
        } catch {
          bad = true
        }
        expect(bad).toBe(true)
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })
})
