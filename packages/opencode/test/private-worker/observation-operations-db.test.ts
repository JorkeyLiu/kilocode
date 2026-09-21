import { describe, it, expect } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { createSessionOperationsDeps } from "../../src/private-worker/session-operations-adapter"
import { ObservationController, OBSERVATION_METHODS, OBSERVATION_VERSION } from "../../src/private-worker/observation"
import { canonicalDirectory } from "../../src/kilocode/session/canonical-directory"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ErrorCode } from "../../src/private-worker/json-rpc"

function tmpDb(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-ops-db-"))
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

async function ensureProject(db: Database.Interface["db"], projectId = "proj_ops") {
  await Effect.runPromise(
    db
      .insert(ProjectTable)
      .values({
        id: projectId as never,
        worktree: "/tmp/ws" as never,
        vcs: "git" as never,
        time_created: 1,
        time_updated: 1,
        sandboxes: [] as never,
      } as never)
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )
}

async function insertSession(db: Database.Interface["db"], id: string, directory: string, projectId = "proj_ops") {
  await Effect.runPromise(
    db
      .insert(SessionTable)
      .values({
        id: id as never,
        project_id: projectId as never,
        slug: `slug-${id}`,
        directory: canonicalDirectory(directory) as never,
        title: `title-${id}`,
        version: "1",
        parent_id: null as never,
        time_created: 10,
        time_updated: 20,
      } as never)
      .run()
      .pipe(Effect.orDie),
  )
}

async function insertOp(
  db: Database.Interface["db"],
  row: {
    op_id: string
    session_id: string
    op_kind: string
    outcome: string
    code: string
    message: string
    time: number
    cancel?: string | null
    detail?: string | null
    stack?: string | null
    revision?: number
    idempotency_hash?: string | null
    request_id?: string | null
    directory?: string | null
    message_id?: string | null
    parent_session_id?: string | null
  },
) {
  await Effect.runPromise(
    db
      .insert(SessionOperationTable)
      .values({
        op_id: row.op_id as never,
        session_id: row.session_id as never,
        op_kind: row.op_kind as never,
        outcome: row.outcome as never,
        code: row.code as never,
        message: row.message as never,
        time: row.time as never,
        cancel: (row.cancel ?? null) as never,
        detail: (row.detail ?? null) as never,
        stack: (row.stack ?? null) as never,
        revision: (row.revision ?? 1) as never,
        idempotency_hash: (row.idempotency_hash ?? null) as never,
        request_id: (row.request_id ?? null) as never,
        directory: (row.directory ?? null) as never,
        message_id: (row.message_id ?? null) as never,
        parent_session_id: (row.parent_session_id ?? null) as never,
      } as never)
      .run()
      .pipe(Effect.orDie),
  )
}

describe("observation/operations DB-backed adapter (real DB, no lease)", () => {
  it("inserts one operation row with detail/stack/raw meta, then observation/operations returns found with finite time and no leak", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_ops_a", dir)
        const insertedTime = Date.now()
        await insertOp(db, {
          op_id: "prompt:msg_ops_a",
          session_id: "ses_ops_a",
          op_kind: "prompt",
          outcome: "failed",
          code: "E_FOO",
          message: "boom",
          time: insertedTime,
          cancel: null,
          detail: "sensitive detail with secret token=xyz",
          stack: "trace with password=123",
          revision: 5,
          idempotency_hash: "hash123",
          request_id: "req123",
          directory: dir,
          message_id: "msg_ops_a",
          parent_session_id: null,
        })

        const deps = createSessionOperationsDeps(db)
        const out = await deps.operations({ directory: dir, sessionId: "ses_ops_a", limit: 1 })
        expect(out.status).toBe("found")
        if (out.status !== "found") throw new Error("expected found")
        expect(out.operations.length).toBe(1)
        const op = out.operations[0]!
        expect(Number.isFinite(op.time)).toBe(true)
        expect(op.time).toBe(insertedTime)
        expect(op.opId).toBe("prompt:msg_ops_a")
        expect(op.outcome).toBe("failed")
        expect(op.code).toBe("E_FOO")
        expect(op.message).toBe("boom")
        // panel-safe keys only
        expect(new Set(Object.keys(op))).toEqual(new Set(["opId", "outcome", "code", "message", "time"]))
        expect("detail" in op).toBe(false)
        expect("stack" in op).toBe(false)
        expect("opKind" in (op as unknown as Record<string, unknown>)).toBe(false)
        expect("idempotencyHash" in (op as unknown as Record<string, unknown>)).toBe(false)
        expect("requestId" in (op as unknown as Record<string, unknown>)).toBe(false)
        expect("revision" in (op as unknown as Record<string, unknown>)).toBe(false)

        // via controller/peer also passes and keeps same wire
        const ctrl = new ObservationController({
          getSnapshot: async () => ({ cursor: 0, snapshot: null }),
          readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
          ack: async () => {},
          operations: deps.operations,
        })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const via = (await client.request(OBSERVATION_METHODS.OPERATIONS, { v: "1.0", directory: dir, sessionId: "ses_ops_a", limit: 1 })) as typeof out
        expect(via).toEqual(out)
        expect((via as unknown as { status: string }).status).toBe("found")
        if ((via as unknown as { status: string }).status === "found") {
          const vop = (via as unknown as { operations: Array<Record<string, unknown>> }).operations[0]!
          expect(Number.isFinite(vop.time as number)).toBe(true)
          expect("detail" in vop).toBe(false)
          expect("stack" in vop).toBe(false)
        }
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })

  it("ordering desc time then desc op_id, limit respected; unknown field rejected at controller", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_ops_order", dir)
        await insertOp(db, { op_id: "prompt:msg_001", session_id: "ses_ops_order", op_kind: "prompt", outcome: "failed", code: "E1", message: "m1", time: 100, revision: 1 })
        await insertOp(db, { op_id: "prompt:msg_002", session_id: "ses_ops_order", op_kind: "prompt", outcome: "failed", code: "E2", message: "m2", time: 200, revision: 2 })
        await insertOp(db, { op_id: "prompt:msg_003", session_id: "ses_ops_order", op_kind: "prompt", outcome: "failed", code: "E3", message: "m3", time: 200, revision: 3 })
        const deps = createSessionOperationsDeps(db)
        const all = await deps.operations({ directory: dir, sessionId: "ses_ops_order", limit: 3 })
        expect(all.status).toBe("found")
        if (all.status !== "found") throw new Error("expected found")
        // desc time, then desc op_id => msg_003 (200, larger id), msg_002 (200), msg_001 (100)
        expect(all.operations.map((o) => o.opId)).toEqual(["prompt:msg_003", "prompt:msg_002", "prompt:msg_001"])
        const lim1 = await deps.operations({ directory: dir, sessionId: "ses_ops_order", limit: 1 })
        if (lim1.status !== "found") throw new Error("expected found")
        expect(lim1.operations.length).toBe(1)
        expect(lim1.operations[0]!.opId).toBe("prompt:msg_003")

        // controller rejects unknown field
        const ctrl = new ObservationController({
          getSnapshot: async () => ({ cursor: 0, snapshot: null }),
          readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
          ack: async () => {},
          operations: deps.operations,
        })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        try {
          await client.request(OBSERVATION_METHODS.OPERATIONS, { v: "1.0", directory: dir, sessionId: "ses_ops_order", limit: 1, extra: 1 })
          expect(false).toBe(true)
        } catch (e) {
          expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
        }
        try {
          await client.request(OBSERVATION_METHODS.OPERATIONS, { v: "1.0", directory: dir, sessionId: "ses_ops_order", limit: 0 })
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

  it("found empty, not_found, scope_mismatch, directory canonicalization", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        const dirOther = canonicalDirectory("/tmp/other")
        await ensureProject(db)
        await insertSession(db, "ses_ops_empty", dir)
        const deps = createSessionOperationsDeps(db)
        const empty = await deps.operations({ directory: dir, sessionId: "ses_ops_empty", limit: 1 })
        expect(empty.status).toBe("found")
        if (empty.status !== "found") throw new Error("expected found")
        expect(empty.operations.length).toBe(0)
        const nf = await deps.operations({ directory: dir, sessionId: "ses_missing", limit: 1 })
        expect(nf).toEqual({ v: "1.0", status: "not_found" })
        // cross-directory => scope_mismatch
        await insertSession(db, "ses_ops_cross", dir)
        await insertOp(db, { op_id: "prompt:msg_cross", session_id: "ses_ops_cross", op_kind: "prompt", outcome: "failed", code: "E", message: "m", time: 1, revision: 1 })
        const sm = await deps.operations({ directory: dirOther, sessionId: "ses_ops_cross", limit: 1 })
        expect(sm).toEqual({ v: "1.0", status: "scope_mismatch" })

        // canonical equivalence: insert with canonical, query with non-canonical spelling
        const raw = "/tmp/ws/./sub/../sub"
        const canon = canonicalDirectory("/tmp/ws/sub")
        await insertSession(db, "ses_ops_canon", canon)
        await insertOp(db, { op_id: "prompt:msg_canon", session_id: "ses_ops_canon", op_kind: "prompt", outcome: "failed", code: "E", message: "m", time: 42, revision: 1 })
        const viaCanon = await deps.operations({ directory: canon, sessionId: "ses_ops_canon", limit: 1 })
        expect(viaCanon.status).toBe("found")
        const viaRaw = await deps.operations({ directory: raw, sessionId: "ses_ops_canon", limit: 1 })
        expect(viaRaw.status).toBe("found")
        if (viaRaw.status === "found") expect(viaRaw.operations[0]!.time).toBe(42)

        const ctrl = new ObservationController({
          getSnapshot: async () => ({ cursor: 0, snapshot: null }),
          readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
          ack: async () => {},
          operations: deps.operations,
        })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const viaPeerCanon = (await client.request(OBSERVATION_METHODS.OPERATIONS, { v: "1.0", directory: raw, sessionId: "ses_ops_canon", limit: 1 })) as typeof viaCanon
        expect(viaPeerCanon.status).toBe("found")
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })

  it("cancel projection retained, opKind never leaked", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_ops_cancel", dir)
        await insertOp(db, { op_id: "prompt:msg_cancel", session_id: "ses_ops_cancel", op_kind: "prompt", outcome: "abandoned", code: "C", message: "cancelled", time: 555, cancel: "user_stop", revision: 1 })
        const deps = createSessionOperationsDeps(db)
        const out = await deps.operations({ directory: dir, sessionId: "ses_ops_cancel", limit: 1 })
        expect(out.status).toBe("found")
        if (out.status !== "found") throw new Error("expected found")
        expect(out.operations[0]!.cancel).toEqual({ source: "user_stop" })
        expect(Object.keys(out.operations[0]!).sort()).toEqual(["cancel", "code", "message", "opId", "outcome", "time"])
        expect("opKind" in (out.operations[0]! as unknown as Record<string, unknown>)).toBe(false)
        const ctrl = new ObservationController({
          getSnapshot: async () => ({ cursor: 0, snapshot: null }),
          readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
          ack: async () => {},
          operations: deps.operations,
        })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const via = (await client.request(OBSERVATION_METHODS.OPERATIONS, { v: "1.0", directory: dir, sessionId: "ses_ops_cancel", limit: 1 })) as typeof out
        expect(via).toEqual(out)
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })

  it("recovery projection for failed/abandoned terminal is panel-safe, invalid shapes throw", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_ops_rec", dir)
        await Effect.runPromise(
          db.insert(SessionOperationTable).values({
            op_id: "prompt:msg_rec_failed" as never,
            session_id: "ses_ops_rec" as never,
            op_kind: "prompt" as never,
            outcome: "failed" as never,
            code: "E" as never,
            message: "m" as never,
            time: 100 as never,
            cancel: null as never,
            detail: null as never,
            stack: null as never,
            revision: 1 as never,
            idempotency_hash: null as never,
            request_id: null as never,
            recovery_budget: 0 as never,
            recovery_next_at: null as never,
            recovery_provenance: "terminal" as never,
          } as never).run().pipe(Effect.orDie),
        )
        const deps = createSessionOperationsDeps(db)
        const out = await deps.operations({ directory: dir, sessionId: "ses_ops_rec", limit: 1 })
        expect(out.status).toBe("found")
        if (out.status !== "found") throw new Error("expected found")
        expect((out.operations[0] as unknown as Record<string, unknown>).recovery).toEqual({ budget: 0, nextAt: null, provenance: "terminal" })
        // succeeded with recovery must throw
        await insertSession(db, "ses_ops_rec2", dir)
        await Effect.runPromise(
          db.insert(SessionOperationTable).values({
            op_id: "prompt:msg_rec_succ" as never,
            session_id: "ses_ops_rec2" as never,
            op_kind: "prompt" as never,
            outcome: "succeeded" as never,
            code: "C" as never,
            message: "ok" as never,
            time: 101 as never,
            cancel: null as never,
            detail: null as never,
            stack: null as never,
            revision: 1 as never,
            idempotency_hash: null as never,
            request_id: null as never,
            recovery_budget: 0 as never,
            recovery_next_at: null as never,
            recovery_provenance: "terminal" as never,
          } as never).run().pipe(Effect.orDie),
        )
        const deps2 = createSessionOperationsDeps(db)
        const ctrl = new ObservationController({
          getSnapshot: async () => ({ cursor: 0, snapshot: null }),
          readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
          ack: async () => {},
          operations: deps2.operations,
        })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        try {
          await client.request(OBSERVATION_METHODS.OPERATIONS, { v: "1.0", directory: dir, sessionId: "ses_ops_rec2", limit: 1 })
          expect(false).toBe(true)
        } catch (e) {
          expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
        }
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })
})
