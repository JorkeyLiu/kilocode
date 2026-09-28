import { describe, expect, it } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { Effect, ManagedRuntime } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperationTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { createSessionOperationsDeps } from "../../src/private-worker/session-operations-adapter"
import { canonicalDirectory, authoritativeDirectory } from "../../src/private-worker/canonical-directory"
import { tryPrivateCreateExact, validatePrivateCreateOperationResult } from "../../src/kilo-provider/session-operation-private"

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

function tmpDb(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-vscode-create-exact-"))
  const file = path.join(dir, "kilo.db")
  return { file, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} } }
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

describe("extension create-operation exact (DB + boundary)", () => {
  it("adapter found is minimal with no leak, absent/scope explicit, symlink same-physical", async () => {
    const { file, cleanup } = tmpDb()
    try {
      await withRuntime(file, async (db) => {
        const dir = canonicalDirectory("/tmp/ws")
        await Effect.runPromise(
          db.insert(ProjectTable).values({ id: "proj_create_ext" as never, worktree: "/tmp/ws" as never, vcs: "git" as never, time_created: 1, time_updated: 1, sandboxes: [] as never } as never).onConflictDoNothing().run().pipe(Effect.orDie),
        )
        await Effect.runPromise(
          db.insert(SessionTable).values({ id: "ses_create_ext" as never, project_id: "proj_create_ext" as never, slug: "slug-ses_create_ext", directory: dir as never, title: "t" as never, version: "1" as never, parent_id: null as never, time_created: 10 as never, time_updated: 20 as never } as never).run().pipe(Effect.orDie),
        )
        const token = "si-cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        await Effect.runPromise(
          db.insert(SessionOperationTable).values({
            op_id: `create:${UUID_A}` as never,
            session_id: "ses_create_ext" as never,
            op_kind: "create" as never,
            outcome: "succeeded" as never,
            code: "create.succeeded" as never,
            message: "create succeeded" as never,
            time: 99 as never,
            cancel: null as never,
            detail: null as never,
            stack: null as never,
            revision: 0 as never,
            idempotency_hash: `create:${UUID_A}` as never,
            request_id: "req" as never,
            directory: dir as never,
            result_snapshot: JSON.stringify({ id: "ses_create_ext", directory: dir }) as never,
            sandbox_token_hash: "hashonly" as never,
          } as never).run().pipe(Effect.orDie),
        )
        const deps = createSessionOperationsDeps(db as never)
        const out = await deps.createOperation({ directory: dir, opId: `create:${UUID_A}` })
        expect(out.status).toBe("found")
        if (out.status !== "found") throw new Error("expected found")
        expect(out.createdSessionId).toBe("ses_create_ext")
        expect(new Set(Object.keys(out))).toEqual(new Set(["v", "status", "createdSessionId"]))
        expect(JSON.stringify(out)).not.toContain(token)
        expect(JSON.stringify(out)).not.toContain("si-")
        expect(JSON.stringify(out)).not.toContain("hashonly")
        const absent = await deps.createOperation({ directory: dir, opId: `create:${UUID_B}` })
        expect(absent.status).toBe("not_found")
        const scope = await deps.createOperation({ directory: canonicalDirectory("/tmp/other"), opId: `create:${UUID_A}` })
        expect(scope.status).toBe("scope_mismatch")
        // symlink alias same-physical
        const base = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-ext-create-alias-"))
        try {
          const sub = path.join(base, "sub")
          fs.mkdirSync(sub, { recursive: true })
          const realSub = fs.realpathSync(sub)
          const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "kilo-ext-create-link-"))
          const linkPath = path.join(linkParent, "linksub")
          let linked = true
          try { fs.symlinkSync(realSub, linkPath) } catch { linked = false }
          if (linked) {
            // seed a second create bound to the real physical dir
            const canonReal = authoritativeDirectory(realSub)
            await Effect.runPromise(
              db.insert(SessionTable).values({ id: "ses_create_alias" as never, project_id: "proj_create_ext" as never, slug: "slug-alias", directory: canonReal as never, title: "t" as never, version: "1" as never, parent_id: null as never, time_created: 10 as never, time_updated: 20 as never } as never).run().pipe(Effect.orDie),
            )
            const uuidC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
            await Effect.runPromise(
              db.insert(SessionOperationTable).values({
                op_id: `create:${uuidC}` as never,
                session_id: "ses_create_alias" as never,
                op_kind: "create" as never,
                outcome: "succeeded" as never,
                code: "create.succeeded" as never,
                message: "create succeeded" as never,
                time: 100 as never,
                cancel: null as never,
                detail: null as never,
                stack: null as never,
                revision: 0 as never,
                idempotency_hash: `create:${uuidC}` as never,
                request_id: "req2" as never,
                directory: canonReal as never,
                result_snapshot: JSON.stringify({ id: "ses_create_alias", directory: canonReal }) as never,
              } as never).run().pipe(Effect.orDie),
            )
            const viaAlias = await deps.createOperation({ directory: linkPath, opId: `create:${uuidC}` })
            expect(viaAlias.status).toBe("found")
          }
          try { fs.rmSync(linkParent, { recursive: true, force: true }) } catch {}
        } finally {
          try { fs.rmSync(base, { recursive: true, force: true }) } catch {}
        }
        void token
      })
    } finally {
      cleanup()
    }
  })

  it("boundary validator accepts minimal found and rejects leaks/invalid", () => {
    const good = { v: "1.0", status: "found", createdSessionId: "ses_ok_1" }
    expect(() => validatePrivateCreateOperationResult(good, `create:${UUID_A}`)).not.toThrow()
    const withSnap = { v: "1.0", status: "found", createdSessionId: "ses_ok_1", snapshot: "{}" }
    expect(() => validatePrivateCreateOperationResult(withSnap, `create:${UUID_A}`)).toThrow()
    const withToken = { v: "1.0", status: "found", createdSessionId: "ses_ok_1", token: "si-x" }
    expect(() => validatePrivateCreateOperationResult(withToken, `create:${UUID_A}`)).toThrow()
    const badId = { v: "1.0", status: "found", createdSessionId: "bad" }
    expect(() => validatePrivateCreateOperationResult(badId, `create:${UUID_A}`)).toThrow()
    const badOp = { v: "1.0", status: "found", createdSessionId: "ses_ok_1" }
    expect(() => validatePrivateCreateOperationResult(badOp, "create:not-a-uuid")).toThrow()
    const nf = { v: "1.0", status: "not_found" }
    expect(() => validatePrivateCreateOperationResult(nf, `create:${UUID_A}`)).not.toThrow()
    const sm = { v: "1.0", status: "scope_mismatch" }
    expect(() => validatePrivateCreateOperationResult(sm, `create:${UUID_A}`)).not.toThrow()
  })

  it("tryPrivateCreateExact maps found/not_found/scope/unavailable explicitly with zero SDK", async () => {
    const foundReader = {
      isEnabled: () => true,
      isStarted: () => true,
      list: async () => ({}) as unknown,
      get: async () => ({}) as unknown,
      createOperation: async () => ({ v: "1.0", status: "found", createdSessionId: "ses_found_1" }),
    } as unknown as Parameters<typeof tryPrivateCreateExact>[0]
    const found = await tryPrivateCreateExact(foundReader, { directory: "/tmp/ws", opId: `create:${UUID_A}` })
    expect(found.kind).toBe("found")
    if (found.kind === "found") expect(found.createdSessionId).toBe("ses_found_1")

    const nfReader = {
      isEnabled: () => true,
      isStarted: () => true,
      list: async () => ({}) as unknown,
      get: async () => ({}) as unknown,
      createOperation: async () => ({ v: "1.0", status: "not_found" }),
    } as unknown as Parameters<typeof tryPrivateCreateExact>[0]
    expect((await tryPrivateCreateExact(nfReader, { directory: "/tmp/ws", opId: `create:${UUID_A}` })).kind).toBe("not_found")

    const smReader = {
      isEnabled: () => true,
      isStarted: () => true,
      list: async () => ({}) as unknown,
      get: async () => ({}) as unknown,
      createOperation: async () => ({ v: "1.0", status: "scope_mismatch" }),
    } as unknown as Parameters<typeof tryPrivateCreateExact>[0]
    expect((await tryPrivateCreateExact(smReader, { directory: "/tmp/ws", opId: `create:${UUID_A}` })).kind).toBe("scope_mismatch")

    expect((await tryPrivateCreateExact(null, { directory: "/tmp/ws", opId: `create:${UUID_A}` })).kind).toBe("unavailable")
    const throwing = {
      isEnabled: () => true,
      isStarted: () => true,
      list: async () => ({}) as unknown,
      get: async () => ({}) as unknown,
      createOperation: async () => { throw new Error("closed") },
    } as unknown as Parameters<typeof tryPrivateCreateExact>[0]
    expect((await tryPrivateCreateExact(throwing, { directory: "/tmp/ws", opId: `create:${UUID_A}` })).kind).toBe("unavailable")
    const malformed = {
      isEnabled: () => true,
      isStarted: () => true,
      list: async () => ({}) as unknown,
      get: async () => ({}) as unknown,
      createOperation: async () => ({ v: "1.0", status: "found", createdSessionId: "bad", snapshot: "{}" }),
    } as unknown as Parameters<typeof tryPrivateCreateExact>[0]
    expect((await tryPrivateCreateExact(malformed, { directory: "/tmp/ws", opId: `create:${UUID_A}` })).kind).toBe("unavailable")
    expect((await tryPrivateCreateExact(foundReader, { directory: "/tmp/ws", opId: "create:bad" })).kind).toBe("unavailable")
    expect((await tryPrivateCreateExact(foundReader, { directory: "/tmp/ws", opId: "fork:ses_x:tok" })).kind).toBe("unavailable")
  })
})
