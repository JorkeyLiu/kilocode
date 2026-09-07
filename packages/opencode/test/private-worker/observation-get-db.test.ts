import { describe, it, expect } from "bun:test"
import { Effect, ManagedRuntime } from "effect"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { createSessionGetDeps } from "../../src/private-worker/session-get-adapter"
import { ObservationController, OBSERVATION_METHODS } from "../../src/private-worker/observation"
import { canonicalDirectory } from "../../src/kilocode/session/canonical-directory"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import { sql } from "drizzle-orm"

function tmpDb(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-get-db-"))
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

const proj = "proj_get_db"

async function ensureProject(db: Database.Interface["db"], worktree = "/tmp/ws"): Promise<void> {
  await Effect.runPromise(
    db
      .insert(ProjectTable)
      .values({
        id: proj as unknown as string,
        worktree: worktree as unknown as string,
        vcs: "git" as unknown as string,
        time_created: 1000,
        time_updated: 1000,
        sandboxes: [] as unknown as string[],
      } as never)
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )
}

async function insertSession(
  db: Database.Interface["db"],
  row: {
    id: string
    directory: string
    title?: string
    parent_id?: string | null
    created?: number
    updated?: number
    agent?: string | null
    projectId?: string
    summary_additions?: number | null
    summary_deletions?: number | null
    summary_files?: number | null
    summary_diffs?: unknown
    revert?: unknown
    time_archived?: number | null
    rawDirectory?: boolean
  },
): Promise<void> {
  const dir = row.rawDirectory ? row.directory : canonicalDirectory(row.directory)
  await Effect.runPromise(
    db
      .insert(SessionTable)
      .values({
        id: row.id as unknown as string,
        project_id: (row.projectId ?? proj) as unknown as string,
        slug: `slug-${row.id}`,
        directory: dir,
        title: row.title ?? `title-${row.id}`,
        version: "1",
        parent_id: (row.parent_id ?? null) as unknown as string,
        time_created: row.created ?? 100,
        time_updated: row.updated ?? 200,
        time_archived: (row.time_archived ?? null) as unknown as number,
        agent: (row.agent ?? null) as unknown as string,
        summary_additions: (row.summary_additions ?? null) as unknown as number,
        summary_deletions: (row.summary_deletions ?? null) as unknown as number,
        summary_files: (row.summary_files ?? null) as unknown as number,
        summary_diffs: (row.summary_diffs ?? null) as unknown as never,
        revert: (row.revert ?? null) as unknown as never,
      } as never)
      .run()
      .pipe(Effect.orDie),
  )
}

describe("observation/get DB-backed projection and scoping (real DB, no lease)", () => {
  it("found projection including parent/agent/summary/revert with strict minimal keys and canonical directory", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db, dir)
        await insertSession(db, {
          id: "ses_parent_get",
          directory: dir,
          title: "parent",
          created: 100,
          updated: 200,
          agent: "agent1",
          summary_additions: 10,
          summary_deletions: 5,
          summary_files: 2,
          summary_diffs: [{ file: "a.txt", additions: 10, deletions: 5, status: "modified" }],
          revert: { messageID: "msg_1", partID: "prt_1", snapshot: "s1", diff: "d1" },
        })
        await insertSession(db, {
          id: "ses_child_get",
          directory: dir,
          title: "child",
          parent_id: "ses_parent_get",
          created: 150,
          updated: 250,
          agent: null,
        })
        const deps = createSessionGetDeps(db)
        const out = await deps.get({ directory: dir, sessionId: "ses_child_get" })
        expect(out.status).toBe("found")
        if (out.status !== "found") throw new Error("expected found")
        expect(out.session.id).toBe("ses_child_get")
        expect(out.session.parentID).toBe("ses_parent_get")
        expect(out.session.directory).toBe(dir)
        expect(out.session.projectID).toBe(proj)
        expect(Object.keys(out.session).sort()).toEqual(["createdAt", "directory", "id", "parentID", "projectID", "title", "updatedAt"])
        // parent with full projection
        const outP = await deps.get({ directory: dir, sessionId: "ses_parent_get" })
        expect(outP.status).toBe("found")
        if (outP.status !== "found") throw new Error("expected found")
        expect(outP.session.agent).toBe("agent1")
        expect(outP.session.summary).toEqual({ additions: 10, deletions: 5, files: 2, diffs: [{ file: "a.txt", additions: 10, deletions: 5, status: "modified" }] })
        expect(outP.session.revert).toEqual({ messageID: "msg_1", partID: "prt_1", snapshot: "s1", diff: "d1" })
        expect(Object.keys(outP.session).sort()).toEqual(["agent", "createdAt", "directory", "id", "parentID", "projectID", "revert", "summary", "title", "updatedAt"])
        // via controller/peer resolves
        const ctrl = new ObservationController({ getSnapshot: async () => ({ cursor: 0, snapshot: null }), readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }), ack: async () => {}, get: deps.get })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const viaPeer = (await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: "ses_parent_get" })) as typeof outP
        expect(viaPeer).toEqual(outP)
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })

  it("archived row is still found (no archived filter)", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, { id: "ses_arch_get", directory: dir, time_archived: Date.now() })
        const deps = createSessionGetDeps(db)
        const out = await deps.get({ directory: dir, sessionId: "ses_arch_get" })
        expect(out.status).toBe("found")
        const ctrl = new ObservationController({ getSnapshot: async () => ({ cursor: 0, snapshot: null }), readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }), ack: async () => {}, get: deps.get })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const via = (await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: "ses_arch_get" })) as typeof out
        expect(via.status).toBe("found")
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })

  it("missing -> not_found resolves, not rejects", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        const deps = createSessionGetDeps(db)
        const out = await deps.get({ directory: dir, sessionId: "ses_missing" })
        expect(out).toEqual({ v: "1.0", status: "not_found" })
        const ctrl = new ObservationController({ getSnapshot: async () => ({ cursor: 0, snapshot: null }), readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }), ack: async () => {}, get: deps.get })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const via = await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: "ses_missing" })
        expect(via).toEqual({ v: "1.0", status: "not_found" })
        // ensure not rejected
        let rejected = false
        try {
          await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: "ses_missing" })
        } catch {
          rejected = true
        }
        expect(rejected).toBe(false)
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })

  it("cross-directory -> scope_mismatch resolves, canonical mismatch", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dirA = canonicalDirectory("/tmp/ws-a")
        const dirB = canonicalDirectory("/tmp/ws-b")
        await ensureProject(db)
        await insertSession(db, { id: "ses_cross_get", directory: dirA })
        const deps = createSessionGetDeps(db)
        const outSame = await deps.get({ directory: dirA, sessionId: "ses_cross_get" })
        expect(outSame.status).toBe("found")
        const outOther = await deps.get({ directory: dirB, sessionId: "ses_cross_get" })
        expect(outOther).toEqual({ v: "1.0", status: "scope_mismatch" })
        const ctrl = new ObservationController({ getSnapshot: async () => ({ cursor: 0, snapshot: null }), readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }), ack: async () => {}, get: deps.get })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const via = await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dirB, sessionId: "ses_cross_get" })
        expect(via).toEqual({ v: "1.0", status: "scope_mismatch" })
        let rejected = false
        try {
          await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dirB, sessionId: "ses_cross_get" })
        } catch {
          rejected = true
        }
        expect(rejected).toBe(false)
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })

  it("lexical canonical equivalent and non-normalized stored row outputs canonical request", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        await ensureProject(db)
        const rawStored = "/tmp/ws/./sub/../sub"
        const canonical = canonicalDirectory("/tmp/ws/sub")
        // Insert with raw non-canonical spelling directly
        await insertSession(db, { id: "ses_norm", directory: rawStored, rawDirectory: true })
        const deps = createSessionGetDeps(db)
        // Query with canonical spelling should find
        const outCanon = await deps.get({ directory: canonical, sessionId: "ses_norm" })
        expect(outCanon.status).toBe("found")
        if (outCanon.status !== "found") throw new Error("expected found")
        expect(outCanon.session.directory).toBe(canonical)
        // Query with non-canonical equivalent should also find and return canonical requested
        const outRaw = await deps.get({ directory: rawStored, sessionId: "ses_norm" })
        expect(outRaw.status).toBe("found")
        if (outRaw.status !== "found") throw new Error("expected found")
        expect(outRaw.session.directory).toBe(canonical)
        // Via peer with raw spelling
        const ctrl = new ObservationController({ getSnapshot: async () => ({ cursor: 0, snapshot: null }), readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }), ack: async () => {}, get: deps.get })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const via = (await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: rawStored, sessionId: "ses_norm" })) as typeof outRaw
        expect(via.status).toBe("found")
        if (via.status === "found") expect(via.session.directory).toBe(canonical)
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })

  it("symlink spelling isolation — lexical distinct", async () => {
    const { file, cleanup } = tmpDb()
    const baseFs = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-get-sym-"))
    const target = path.join(baseFs, "target")
    fs.mkdirSync(target, { recursive: true })
    const link = path.join(baseFs, "link")
    let symlinkOk = false
    try {
      fs.symlinkSync(target, link, "dir")
      symlinkOk = true
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS" || String(e).includes("operation not permitted")) symlinkOk = false
      else throw e
    }
    const canonLink = canonicalDirectory(link)
    const canonTarget = canonicalDirectory(target)
    if (symlinkOk) expect(canonLink).not.toBe(canonTarget)
    try {
      await withRuntime(file, async (db) => {
        await ensureProject(db)
        const dirLink = symlinkOk ? canonLink : canonicalDirectory(path.join(baseFs, "dirA"))
        const dirTarget = symlinkOk ? canonTarget : canonicalDirectory(path.join(baseFs, "dirB"))
        await insertSession(db, { id: "ses_link", directory: dirLink })
        await insertSession(db, { id: "ses_target", directory: dirTarget })
        const deps = createSessionGetDeps(db)
        const viaLink = await deps.get({ directory: link, sessionId: "ses_link" })
        expect(viaLink.status).toBe("found")
        const viaTarget = await deps.get({ directory: target, sessionId: "ses_target" })
        expect(viaTarget.status).toBe("found")
        // cross should be mismatch
        const cross1 = await deps.get({ directory: target, sessionId: "ses_link" })
        expect(cross1).toEqual({ v: "1.0", status: "scope_mismatch" })
        const cross2 = await deps.get({ directory: link, sessionId: "ses_target" })
        expect(cross2).toEqual({ v: "1.0", status: "scope_mismatch" })
        if (symlinkOk) {
          // also via peer
          const ctrl = new ObservationController({ getSnapshot: async () => ({ cursor: 0, snapshot: null }), readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }), ack: async () => {}, get: deps.get })
          const aToB = new PassThrough()
          const bToA = new PassThrough()
          const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
          const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
          const viaPeerCross = await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: target, sessionId: "ses_link" })
          expect(viaPeerCross).toEqual({ v: "1.0", status: "scope_mismatch" })
          client.dispose()
          server.dispose()
        }
      })
    } finally {
      cleanup()
      fs.rmSync(baseFs, { recursive: true, force: true })
    }
  })

  it("partial/null summary semantics exactly as fromRow", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        // all null => no summary
        await insertSession(db, { id: "ses_sum_none", directory: dir, summary_additions: null, summary_deletions: null, summary_files: null, summary_diffs: null })
        // one non-null => summary present with defaults and no diffs key when null
        await insertSession(db, { id: "ses_sum_partial", directory: dir, summary_additions: 5, summary_deletions: null, summary_files: null, summary_diffs: null })
        // explicit zeros with diffs array
        await insertSession(db, { id: "ses_sum_full", directory: dir, summary_additions: 0, summary_deletions: 0, summary_files: 0, summary_diffs: [] })
        // with diffs
        await insertSession(db, { id: "ses_sum_diffs", directory: dir, summary_additions: 1, summary_deletions: 2, summary_files: 1, summary_diffs: [{ file: "a.txt", additions: 1, deletions: 2, status: "added" }] })
        const deps = createSessionGetDeps(db)
        const none = await deps.get({ directory: dir, sessionId: "ses_sum_none" })
        expect(none.status).toBe("found")
        if (none.status !== "found") throw new Error("expected found")
        expect(none.session.summary).toBeUndefined()
        const partial = await deps.get({ directory: dir, sessionId: "ses_sum_partial" })
        expect(partial.status).toBe("found")
        if (partial.status !== "found") throw new Error("expected found")
        expect(partial.session.summary).toEqual({ additions: 5, deletions: 0, files: 0 })
        expect(partial.session.summary?.diffs).toBeUndefined()
        expect("diffs" in (partial.session.summary as unknown as Record<string, unknown>)).toBe(false)
        const full = await deps.get({ directory: dir, sessionId: "ses_sum_full" })
        expect(full.status).toBe("found")
        if (full.status !== "found") throw new Error("expected found")
        expect(full.session.summary).toEqual({ additions: 0, deletions: 0, files: 0, diffs: [] })
        const withDiffs = await deps.get({ directory: dir, sessionId: "ses_sum_diffs" })
        expect(withDiffs.status).toBe("found")
        if (withDiffs.status !== "found") throw new Error("expected found")
        expect(withDiffs.session.summary).toEqual({ additions: 1, deletions: 2, files: 1, diffs: [{ file: "a.txt", additions: 1, deletions: 2, status: "added" }] })
      })
    } finally {
      cleanup()
    }
  })

  it("agent empty string is preserved exactly matching fromRow", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        await insertSession(db, { id: "ses_agent_empty", directory: dir, agent: "" })
        await insertSession(db, { id: "ses_agent_null", directory: dir, agent: null })
        await insertSession(db, { id: "ses_agent_x", directory: dir, agent: "agentX" })
        const deps = createSessionGetDeps(db)
        const empty = await deps.get({ directory: dir, sessionId: "ses_agent_empty" })
        expect(empty.status).toBe("found")
        if (empty.status !== "found") throw new Error("expected found")
        expect(empty.session.agent).toBe("")
        expect(Object.keys(empty.session).includes("agent")).toBe(true)
        const nul = await deps.get({ directory: dir, sessionId: "ses_agent_null" })
        expect(nul.status).toBe("found")
        if (nul.status !== "found") throw new Error("expected found")
        expect(nul.session.agent).toBeUndefined()
        expect("agent" in nul.session).toBe(false)
        const x = await deps.get({ directory: dir, sessionId: "ses_agent_x" })
        expect(x.status).toBe("found")
        if (x.status !== "found") throw new Error("expected found")
        expect(x.session.agent).toBe("agentX")
        // also via peer
        const ctrl = new ObservationController({ getSnapshot: async () => ({ cursor: 0, snapshot: null }), readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }), ack: async () => {}, get: deps.get })
        const aToB = new PassThrough()
        const bToA = new PassThrough()
        const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
        const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
        const viaEmpty = (await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: "ses_agent_empty" })) as typeof empty
        expect(viaEmpty.status).toBe("found")
        if (viaEmpty.status === "found") expect(viaEmpty.session.agent).toBe("")
        const viaNull = (await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: "ses_agent_null" })) as typeof nul
        expect(viaNull.status).toBe("found")
        if (viaNull.status === "found") expect(viaNull.session.agent).toBeUndefined()
        client.dispose()
        server.dispose()
      })
    } finally {
      cleanup()
    }
  })

  it("malformed stored optional JSON/shapes -> InternalError where realistically insertable", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await ensureProject(db)
        // summary diffs with patch forbidden
        await insertSession(db, { id: "ses_bad_patch", directory: dir, summary_additions: 1, summary_deletions: 1, summary_files: 1, summary_diffs: [{ additions: 1, deletions: 1, patch: "bad" } as unknown as never] })
        // summary diffs with invalid status
        await insertSession(db, { id: "ses_bad_status", directory: dir, summary_additions: 1, summary_deletions: 1, summary_files: 1, summary_diffs: [{ additions: 1, deletions: 1, status: "renamed" } as unknown as never] })
        // summary diffs not array (string via cast)
        await insertSession(db, { id: "ses_bad_diffs_shape", directory: dir, summary_additions: 1, summary_deletions: 1, summary_files: 1, summary_diffs: "not-array" as unknown as never })
        // revert with invalid messageID
        await insertSession(db, { id: "ses_bad_revert_msg", directory: dir, revert: { messageID: "bad" } as unknown as never })
        // revert with extra key
        await insertSession(db, { id: "ses_bad_revert_extra", directory: dir, revert: { messageID: "msg_1", extra: 1 } as unknown as never })
        // summary with non-finite (Infinity) via raw sql bypass type check
        // Use raw sql to insert Infinity as stored number that fails finite check — drizzle will store Infinity as null? Instead use cast with Infinity
        await insertSession(db, { id: "ses_bad_finite", directory: dir, summary_additions: Infinity as unknown as number, summary_deletions: 0, summary_files: 0 })

        const deps = createSessionGetDeps(db)
        const cases = ["ses_bad_patch", "ses_bad_status", "ses_bad_diffs_shape", "ses_bad_revert_msg", "ses_bad_revert_extra", "ses_bad_finite"]
        for (const sid of cases) {
          try {
            await deps.get({ directory: dir, sessionId: sid })
            expect(false).toBe(true)
          } catch (e) {
            expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
          }
          // also via controller peer -> InternalError
          const ctrl = new ObservationController({ getSnapshot: async () => ({ cursor: 0, snapshot: null }), readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }), ack: async () => {}, get: deps.get })
          const aToB = new PassThrough()
          const bToA = new PassThrough()
          const server = new JsonRpcPeer({ reader: aToB, writer: bToA, onRequest: (m, p) => ctrl.handle(m, p) })
          const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
          try {
            await client.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: sid })
            expect(false).toBe(true)
          } catch (e) {
            expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
          }
          client.dispose()
          server.dispose()
        }

        // also test raw malformed JSON via sql (invalid JSON string that fails parse)
        await Effect.runPromise(
          db
            .insert(SessionTable)
            .values({
              id: "ses_raw_bad_json" as unknown as string,
              project_id: proj as unknown as string,
              slug: "slug-raw",
              directory: dir,
              title: "raw bad",
              version: "1",
              parent_id: null as unknown as string,
              time_created: 100,
              time_updated: 200,
              summary_additions: 1 as unknown as number,
              summary_deletions: 1 as unknown as number,
              summary_files: 1 as unknown as number,
              summary_diffs: "not-json" as unknown as never,
            } as never)
            .run()
            .pipe(Effect.orDie),
        )
        try {
          await deps.get({ directory: dir, sessionId: "ses_raw_bad_json" })
          expect(false).toBe(true)
        } catch (e) {
          expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
        }
        {
          const ctrlRaw = new ObservationController({ getSnapshot: async () => ({ cursor: 0, snapshot: null }), readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }), ack: async () => {}, get: deps.get })
          const aRaw = new PassThrough()
          const bRaw = new PassThrough()
          const sRaw = new JsonRpcPeer({ reader: aRaw, writer: bRaw, onRequest: (m, p) => ctrlRaw.handle(m, p) })
          const cRaw = new JsonRpcPeer({ reader: bRaw, writer: aRaw })
          try {
            await cRaw.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: "ses_raw_bad_json" })
            expect(false).toBe(true)
          } catch (e) {
            expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
          }
          cRaw.dispose()
          sRaw.dispose()
        }

        // deterministic raw invalid revert JSON via direct SQL — stores syntactically valid JSON that fails shape validation
        await Effect.runPromise(db.run(sql`UPDATE session SET revert = '{"messageID":"bad"}' WHERE id = 'ses_bad_revert_msg'`).pipe(Effect.orDie))
        try {
          await deps.get({ directory: dir, sessionId: "ses_bad_revert_msg" })
          expect(false).toBe(true)
        } catch (e) {
          expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
        }
        {
          const ctrl2 = new ObservationController({ getSnapshot: async () => ({ cursor: 0, snapshot: null }), readAfter: async () => ({ type: "deltas", cursor: 0, entries: [] }), ack: async () => {}, get: deps.get })
          const a2 = new PassThrough()
          const b2 = new PassThrough()
          const s2 = new JsonRpcPeer({ reader: a2, writer: b2, onRequest: (m, p) => ctrl2.handle(m, p) })
          const c2 = new JsonRpcPeer({ reader: b2, writer: a2 })
          try {
            await c2.request(OBSERVATION_METHODS.GET, { v: "1.0", directory: dir, sessionId: "ses_bad_revert_msg" })
            expect(false).toBe(true)
          } catch (e) {
            expect((e as { code?: number }).code).toBe(ErrorCode.InternalError)
          }
          c2.dispose()
          s2.dispose()
        }
      })
    } finally {
      cleanup()
    }
  })
})
