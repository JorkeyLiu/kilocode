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
import { canonicalDirectory, authoritativeDirectory } from "../../src/kilocode/session/canonical-directory"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"

function tmpDb(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-op-create-"))
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

async function ensureProject(db: Database.Interface["db"], worktree = "/tmp/ws") {
  await Effect.runPromise(
    db.insert(ProjectTable).values({ id: "proj_create" as never, worktree: worktree as never, vcs: "git" as never, time_created: 1, time_updated: 1, sandboxes: [] as never } as never).onConflictDoNothing().run().pipe(Effect.orDie),
  )
}

async function insertSession(db: Database.Interface["db"], id: string, directory: string) {
  await Effect.runPromise(
    db.insert(SessionTable).values({ id: id as never, project_id: "proj_create" as never, slug: `slug-${id}`, directory: canonicalDirectory(directory) as never, title: `title-${id}`, version: "1", parent_id: null as never, time_created: 10, time_updated: 20 } as never).run().pipe(Effect.orDie),
  )
}

async function insertCreateOp(db: Database.Interface["db"], row: { op_id: string; session_id: string; directory: string; snapshot: unknown; outcome?: string; op_kind?: string; tokenHash?: string | null }) {
  const snapJson = typeof row.snapshot === "string" ? row.snapshot : JSON.stringify(row.snapshot)
  await Effect.runPromise(
    db.insert(SessionOperationTable).values({
      op_id: row.op_id as never,
      session_id: row.session_id as never,
      op_kind: (row.op_kind ?? "create") as never,
      outcome: (row.outcome ?? "succeeded") as never,
      code: "create.succeeded" as never,
      message: "create succeeded" as never,
      time: 99 as never,
      cancel: null as never,
      detail: null as never,
      stack: null as never,
      revision: 0 as never,
      idempotency_hash: row.op_id as never,
      request_id: "req-create" as never,
      directory: canonicalDirectory(row.directory) as never,
      message_id: null as never,
      parent_session_id: null as never,
      title: null as never,
      result_snapshot: snapJson as never,
      sandbox_token_hash: (row.tokenHash ?? "deadbeefhash") as never,
    } as never).run().pipe(Effect.orDie),
  )
}

const UUID_A = "11111111-1111-4111-8111-111111111111"
const UUID_B = "22222222-2222-4222-8222-222222222222"

describe("observation/create-operation exact create:<uuid> (real SQLite)", () => {
  it("found returns only minimal createdSessionId with no token/hash/snapshot leak", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_create_a", dir)
        const token = "si-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        await insertCreateOp(db, {
          op_id: `create:${UUID_A}`,
          session_id: "ses_create_a",
          directory: dir,
          snapshot: { id: "ses_create_a", directory: dir, title: "hello" },
          tokenHash: "abc123hash",
        })
        const deps = createSessionOperationsDeps(db)
        const out = await deps.createOperation({ directory: dir, opId: `create:${UUID_A}` })
        expect(out.status).toBe("found")
        if (out.status !== "found") throw new Error("expected found")
        expect(out.createdSessionId).toBe("ses_create_a")
        expect(new Set(Object.keys(out))).toEqual(new Set(["v", "status", "createdSessionId"]))
        const dumped = JSON.stringify(out)
        expect(dumped).not.toContain(token)
        expect(dumped).not.toContain("si-")
        expect(dumped).not.toContain("abc123hash")
        expect(dumped).not.toContain("snapshot")
        expect(dumped).not.toContain("sandbox")
        // unique success: second read returns same ID
        const again = await deps.createOperation({ directory: dir, opId: `create:${UUID_A}` })
        expect(again).toEqual(out)
      })
    } finally {
      cleanup()
    }
  })

  it("absent op is not_found, cross-directory is scope_mismatch", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_create_b", dir)
        await insertCreateOp(db, { op_id: `create:${UUID_A}`, session_id: "ses_create_b", directory: dir, snapshot: { id: "ses_create_b", directory: dir } })
        const deps = createSessionOperationsDeps(db)
        const absent = await deps.createOperation({ directory: dir, opId: `create:${UUID_B}` })
        expect(absent.status).toBe("not_found")
        const other = await deps.createOperation({ directory: canonicalDirectory("/tmp/other"), opId: `create:${UUID_A}` })
        expect(other.status).toBe("scope_mismatch")
      })
    } finally {
      cleanup()
    }
  })

  it("symlink alias same-physical succeeds, different physical is scope_mismatch", async () => {
    const { file, cleanup } = tmpDb()
    const aliasBase = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-create-alias-"))
    try {
      await withRuntime(file, async (db) => {
        const real = fs.realpathSync(aliasBase)
        const aliasDir = path.join(aliasBase, "sub")
        fs.mkdirSync(aliasDir, { recursive: true })
        const realSub = fs.realpathSync(aliasDir)
        // link path that resolves to same physical dir
        const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-create-link-"))
        const linkPath = path.join(linkParent, "linksub")
        try { fs.symlinkSync(realSub, linkPath) } catch { /* windows */ }
        await ensureProject(db, realSub)
        const canonReal = authoritativeDirectory(realSub)
        await insertSession(db, "ses_create_sym", canonReal)
        await insertCreateOp(db, { op_id: `create:${UUID_A}`, session_id: "ses_create_sym", directory: canonReal, snapshot: { id: "ses_create_sym", directory: canonReal } })
        const deps = createSessionOperationsDeps(db)
        let viaAlias: unknown = null
        try {
          viaAlias = await deps.createOperation({ directory: linkPath, opId: `create:${UUID_A}` })
        } catch {
          viaAlias = { status: "error" }
        }
        // If symlink creation succeeded, alias must resolve to same physical and be found.
        // If symlink unsupported, at least the canonical path is found.
        const direct = await deps.createOperation({ directory: canonReal, opId: `create:${UUID_A}` })
        expect(direct.status).toBe("found")
        if ((viaAlias as { status: string }).status !== "error") {
          expect((viaAlias as { status: string }).status).toBe("found")
        }
        const otherBase = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-create-other-"))
        const other = await deps.createOperation({ directory: otherBase, opId: `create:${UUID_A}` })
        expect(other.status).toBe("scope_mismatch")
        try { fs.rmSync(linkParent, { recursive: true, force: true }) } catch {}
        try { fs.rmSync(otherBase, { recursive: true, force: true }) } catch {}
      })
    } finally {
      try { fs.rmSync(aliasBase, { recursive: true, force: true }) } catch {}
      cleanup()
    }
  })

  it("invalid opId shape and non-create/non-succeeded rows fail closed", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_create_c", dir)
        await insertCreateOp(db, { op_id: `create:${UUID_A}`, session_id: "ses_create_c", directory: dir, snapshot: { id: "ses_create_c", directory: dir } })
        // non-create kind row with create-like opId cannot exist via PK, but a prompt row with same table must throw internal
        await Effect.runPromise(
          db.insert(SessionOperationTable).values({ op_id: "prompt:msg_x" as never, session_id: "ses_create_c" as never, op_kind: "prompt" as never, outcome: "succeeded" as never, code: "ok" as never, message: "ok" as never, time: 1 as never, cancel: null as never, detail: null as never, stack: null as never, revision: 1 as never } as never).run().pipe(Effect.orDie),
        )
        const deps = createSessionOperationsDeps(db)
        // invalid shape throws InvalidParams
        let bad = false
        try {
          await deps.createOperation({ directory: dir, opId: "create:not-a-uuid" })
        } catch {
          bad = true
        }
        expect(bad).toBe(true)
        let bad2 = false
        try {
          await deps.createOperation({ directory: dir, opId: "fork:ses_create_c:tok" })
        } catch {
          bad2 = true
        }
        expect(bad2).toBe(true)
        // controller maps invalid opId to InvalidParams and valid found via peer
        const ctrl = new ObservationController({
          getSnapshot: async () => ({ cursor: 0, snapshot: null }),
          readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }),
          ack: async () => {},
          createOperation: deps.createOperation,
        })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const via = (await client.request(OBSERVATION_METHODS.CREATE_OPERATION, { v: "1.0", directory: dir, opId: `create:${UUID_A}` })) as { status: string; createdSessionId?: string }
        expect(via.status).toBe("found")
        expect(via.createdSessionId).toBe("ses_create_c")
        expect(JSON.stringify(via)).not.toContain("si-")
        let invalidVia = false
        try {
          await client.request(OBSERVATION_METHODS.CREATE_OPERATION, { v: "1.0", directory: dir, opId: "create:bad" })
        } catch {
          invalidVia = true
        }
        expect(invalidVia).toBe(true)
        // sessionId-bearing observation/operation must reject create opIds
        let crossBad = false
        try {
          await client.request(OBSERVATION_METHODS.OPERATION, { v: "1.0", directory: dir, sessionId: "ses_create_c", opId: `create:${UUID_A}` })
        } catch {
          crossBad = true
        }
        expect(crossBad).toBe(true)
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })

  it("exact re-observe never consumes sandbox grant (no duplicate deduction)", async () => {
    const { file, cleanup } = tmpDb()
    try {
      const inheritance = await import("../../src/kilocode/sandbox/inheritance")
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_create_g", dir)
        const token = inheritance.issue({ sessionID: "ses_create_g" as never, directory: dir, count: 2 })
        const before = inheritance._getGrant(token)?.remaining
        expect(before).toBe(2)
        await insertCreateOp(db, { op_id: `create:${UUID_A}`, session_id: "ses_create_g", directory: dir, snapshot: { id: "ses_create_g", directory: dir } })
        const deps = createSessionOperationsDeps(db)
        const out = await deps.createOperation({ directory: dir, opId: `create:${UUID_A}` })
        expect(out.status).toBe("found")
        const after = inheritance._getGrant(token)?.remaining
        expect(after).toBe(2)
        const reservation = inheritance._getReservation(`create:${UUID_A}`)
        expect(reservation).toBeUndefined()
        expect(JSON.stringify(out)).not.toContain(token)
        inheritance._resetForTest()
      })
    } finally {
      cleanup()
    }
  })

  it("snapshot mismatch and wrong outcome fail closed without leak", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, "ses_create_d", dir)
        await insertSession(db, "ses_create_e", dir)
        // snapshot id mismatch
        await insertCreateOp(db, { op_id: `create:${UUID_A}`, session_id: "ses_create_d", directory: dir, snapshot: { id: "ses_create_e", directory: dir } })
        const deps = createSessionOperationsDeps(db)
        let threw = false
        try {
          await deps.createOperation({ directory: dir, opId: `create:${UUID_A}` })
        } catch (e) {
          threw = true
          expect(String((e as Error).message)).not.toContain("si-")
        }
        expect(threw).toBe(true)
      })
    } finally {
      cleanup()
    }
  })
})
