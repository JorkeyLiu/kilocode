import { describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Effect, ManagedRuntime } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { createSessionOperationsDeps } from "../../src/private-worker/session-operations-adapter"
import { ObservationController, OBSERVATION_METHODS } from "../../src/private-worker/observation"
import { canonicalDirectory } from "../../src/private-worker/canonical-directory"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"

function tmpDb(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-ops-update-"))
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
      .values({ id: "proj_update" as never, worktree: "/tmp/ws" as never, vcs: "git" as never, time_created: 1, time_updated: 1, sandboxes: [] as never } as never)
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )
}

async function insertSession(db: Database.Interface["db"], id: string, directory: string) {
  await Effect.runPromise(
    db
      .insert(SessionTable)
      .values({
        id: id as never,
        project_id: "proj_update" as never,
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
  row: { op_id: string; session_id: string; outcome: string; code: string; message: string; time: number },
) {
  await Effect.runPromise(
    db
      .insert(SessionOperationTable)
      .values({
        op_id: row.op_id as never,
        session_id: row.session_id as never,
        op_kind: "sessionUpdate" as never,
        outcome: row.outcome as never,
        code: row.code as never,
        message: row.message as never,
        time: row.time as never,
        cancel: null as never,
        detail: "secret" as never,
        stack: "trace" as never,
        revision: 1 as never,
        idempotency_hash: null as never,
        request_id: null as never,
      } as never)
      .run()
      .pipe(Effect.orDie),
  )
}

describe("observation/operation sessionUpdate exact (vscode mirror, real DB)", () => {
  it("sessionUpdate:<sessionId>:<token> exact is panel-safe with strict binding", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_update_a", dir)
        await insertSession(db, "ses_update_b", dir)
        await insertOp(db, {
          op_id: "sessionUpdate:ses_update_a:tok1",
          session_id: "ses_update_a",
          outcome: "succeeded",
          code: "sessionUpdate.succeeded",
          message: "sessionUpdate succeeded",
          time: 11,
        })
        await insertOp(db, {
          op_id: "sessionUpdate:ses_update_b:tok9",
          session_id: "ses_update_b",
          outcome: "succeeded",
          code: "sessionUpdate.succeeded",
          message: "sessionUpdate succeeded",
          time: 12,
        })
        const deps = createSessionOperationsDeps(db as never)
        const out = await deps.operation({ directory: dir, sessionId: "ses_update_a", opId: "sessionUpdate:ses_update_a:tok1" })
        expect(out.status).toBe("found")
        if (out.status !== "found") throw new Error("expected found")
        expect(out.operation.opId).toBe("sessionUpdate:ses_update_a:tok1")
        expect(new Set(Object.keys(out.operation))).toEqual(new Set(["opId", "outcome", "code", "message", "time"]))
        expect("recovery" in out.operation).toBe(false)
        const cross = await deps.operation({ directory: dir, sessionId: "ses_update_a", opId: "sessionUpdate:ses_update_b:tok9" })
        expect(cross.status).toBe("scope_mismatch")
        const ctrl = new ObservationController({
          getSnapshot: async () => ({ cursor: 0, snapshot: null }),
          readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
          ack: async () => {},
          operations: deps.operations as never,
          operation: deps.operation as never,
        })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const via = (await client.request(OBSERVATION_METHODS.OPERATION, {
          v: "1.0",
          directory: dir,
          sessionId: "ses_update_a",
          opId: "sessionUpdate:ses_update_a:tok1",
        })) as typeof out
        expect(via).toEqual(out)
        for (const badOp of ["create:tok1", "sessionUpdate:ses_update_a"]) {
          let bad = false
          try {
            await client.request(OBSERVATION_METHODS.OPERATION, { v: "1.0", directory: dir, sessionId: "ses_update_a", opId: badOp })
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
})
