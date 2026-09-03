// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { Session } from "../../../src/session/session"
import { SessionID } from "../../../src/session/schema"
import { SessionForkDispatchService } from "../../../src/kilocode/session/session-fork-dispatch"
import { testEffect } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime } from "../../../src/effect/app-runtime"
import * as Log from "@opencode-ai/core/util/log"
import { Storage } from "../../../src/storage/storage"
import { baseKey } from "../../../src/kilocode/session-portability/cumulative-diff"
import { KiloSession } from "../../../src/kilocode/session"
import { ForkSeam } from "../../../src/kilocode/session/fork-seam"
import { SandboxStore } from "../../../src/kilocode/sandbox/store"
import { Global } from "@opencode-ai/core/global"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"

void Log.init({ print: false })

const it = testEffect(Layer.empty)

afterEach(async () => {
  ForkSeam.nextId = undefined
  ForkSeam.failFirstDiffWrite = false
  ForkSeam.failSecondDiffWrite = false
  ForkSeam.failSandboxWrite = false
  ForkSeam.failTxAfterFs = false
  ;(ForkSeam as unknown as { failClaimedWriteAfterOpen?: boolean }).failClaimedWriteAfterOpen = false
  ForkSeam.failCleanupFs = false
  ForkSeam.failCleanupStorage = false
  ForkSeam.capturedCleanupWarnings.length = 0
  await disposeAllInstances()
  await resetDatabase()
})

describe("sessionFork ownership claim", () => {
  it.live("first diff write failure fails closed and cleans no owned file, preserves source", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "src-first-fail" }) })))) as unknown as Effect.Effect<any, any, any>)
      const diff = [{ file: "a.txt", patch: "diff", additions: 1, deletions: 0 } as unknown as any]
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.write(baseKey(source.id), diff); yield* s.write(["session_diff", source.id], diff) })))) as unknown as Effect.Effect<any, any, any>)
      const knownTarget = SessionID.descending()
      ForkSeam.nextId = knownTarget as string
      ForkSeam.failFirstDiffWrite = true
      const token = "first-fail-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-first-fail", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      ForkSeam.failFirstDiffWrite = false
      expect(res.status).toBe("failed")
      expect(res.failure.code).toBe("internal")
      // no target files
      const baseExists = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(knownTarget)).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false))) })))) as unknown as Effect.Effect<any, any, any>)
      const diffExists = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(["session_diff", knownTarget]).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false))) })))) as unknown as Effect.Effect<any, any, any>)
      expect(baseExists).toBe(false)
      expect(diffExists).toBe(false)
      // source preserved
      const srcBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(source.id)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(srcBase).toEqual(diff)
      // no DB ghost
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).length).toBe(1)
      expect((list as any[])[0].id).toBe(source.id)
      expect(KiloSession.resolveParent(knownTarget as string)).toBeUndefined()
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.remove(baseKey(source.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(["session_diff", source.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)) })))) as unknown as Effect.Effect<any, any, any>)
    }),
  )

  it.live("sandbox write failure cleans owned diff and leaves no sandbox ghost", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "src-sandbox-fail" }) })))) as unknown as Effect.Effect<any, any, any>)
      const diff = [{ file: "s.txt", patch: "diff", additions: 1, deletions: 0 } as unknown as any]
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.write(baseKey(source.id), diff); yield* s.write(["session_diff", source.id], diff) })))) as unknown as Effect.Effect<any, any, any>)
      const srcSandbox = { enabled: true, mode: "deny" as const, allowedHosts: [], writablePaths: ["/tmp"], version: 0 }
      yield* Effect.promise(() => SandboxStore.write(dir, source.id as unknown as SessionID, srcSandbox))
      const knownTarget = SessionID.descending()
      ForkSeam.nextId = knownTarget as string
      ForkSeam.failSandboxWrite = true
      const token = "sb-fail-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-sb-fail", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      ForkSeam.failSandboxWrite = false
      expect(res.status).toBe("failed")
      expect(res.failure.code).toBe("internal")
      const baseExists = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(knownTarget)).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false))) })))) as unknown as Effect.Effect<any, any, any>)
      const diffExists = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(["session_diff", knownTarget]).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false))) })))) as unknown as Effect.Effect<any, any, any>)
      expect(baseExists).toBe(false)
      expect(diffExists).toBe(false)
      const sandboxExists = yield* Effect.promise(() => SandboxStore.read(dir, knownTarget as unknown as SessionID).then((v) => !!v).catch(() => false))
      expect(sandboxExists).toBe(false)
      const srcBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(source.id)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(srcBase).toEqual(diff)
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).length).toBe(1)
      yield* Effect.promise(() => SandboxStore.remove(dir, source.id as unknown as SessionID))
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.remove(baseKey(source.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(["session_diff", source.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)) })))) as unknown as Effect.Effect<any, any, any>)
    }),
  )

  it.live("failed probe (sandbox invalid) fails closed and preserves preexisting unrelated artifact", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "src-probe" }) })))) as unknown as Effect.Effect<any, any, any>)
      // create unrelated artifact that must be preserved
      const unrelatedId = SessionID.descending()
      const unrelatedDiff = [{ file: "unrelated.txt", patch: "keep", additions: 5, deletions: 5 } as unknown as any]
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.write(baseKey(unrelatedId), unrelatedDiff); yield* s.write(["session_diff", unrelatedId], unrelatedDiff) })))) as unknown as Effect.Effect<any, any, any>)
      // create invalid sandbox file for target to cause probe error (valid() will throw)
      const knownTarget = SessionID.descending()
      // write invalid JSON directly via fs to simulate probe error
      const SS = yield* Effect.promise(() => import("../../../src/kilocode/sandbox/store")).pipe(Effect.map((m) => (m as unknown as { SandboxStore: { root: string } }).SandboxStore))
      const targetFile = path.join((SS as unknown as { root: string }).root, createHash("sha256").update(knownTarget).digest("hex"), createHash("sha256").update(dir).digest("hex") + ".json")
      // Ensure dir exists and write invalid content
      yield* Effect.promise(() => fs.mkdir(path.dirname(targetFile), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(targetFile, "not-json", "utf8"))
      ForkSeam.nextId = knownTarget as string
      const token = "probe-fail-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-probe-fail", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(res.status).toBe("failed")
      expect(res.failure.code).toBe("internal")
      // unrelated preserved
      const afterUnrelated = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(unrelatedId)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterUnrelated).toEqual(unrelatedDiff)
      // invalid probe file still exists and not deleted (since not owned, probe failed before ownership)
      const stillInvalid = yield* Effect.promise(() => fs.readFile(targetFile, "utf8").catch(() => undefined))
      expect(stillInvalid).toBe("not-json")
      // no DB ghost
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).length).toBe(1)
      expect((list as any[])[0].id).toBe(source.id)
      // cleanup
      yield* Effect.promise(() => fs.rm(targetFile, { force: true }))
      yield* Effect.promise(() => fs.rmdir(path.dirname(targetFile)).catch(() => undefined as void))
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.remove(baseKey(unrelatedId)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(["session_diff", unrelatedId]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)) })))) as unknown as Effect.Effect<any, any, any>)
    }),
  )

  it.live("target ID collision (SessionTable occupied) fails conflict without touching FS", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "src-collision" }) })))) as unknown as Effect.Effect<any, any, any>)
      const diff = [{ file: "coll.txt", patch: "diff", additions: 1, deletions: 0 } as unknown as any]
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.write(baseKey(source.id), diff); yield* s.write(["session_diff", source.id], diff) })))) as unknown as Effect.Effect<any, any, any>)
      // pre-create a session with knownTarget ID to cause collision
      const knownTarget = SessionID.descending()
      // create collision session via direct DB insert + minimal required fields
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const { db } = yield* Database.Service
        const { ProjectTable } = yield* Effect.promise(() => import("@opencode-ai/core/project/sql"))
        const ctx = yield* (yield* Effect.promise(() => import("../../../src/effect/instance-ref"))).InstanceRef as unknown as { get: () => Promise<any> }
        // Instead use Session.create to create a real session and then force its ID to knownTarget via direct insert? Simpler: create a session and then update its ID?
        // We'll create a dummy session via Service and then manually insert a row with knownTarget ID using db
        const dummy = yield* (yield* Session.Service).create({ title: "dummy-collision" })
        // Now insert a row with knownTarget ID directly (if dummy ID != knownTarget, insert another)
        // Use raw db insert for collision: insert SessionTable with knownTarget
        const { SessionTable: ST } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
        const { ProjectV2 } = yield* Effect.promise(() => import("@opencode-ai/core/project"))
        // Need project/worktree context: use instance store
        const store = yield* (yield* Effect.promise(() => import("../../../src/project/instance-store"))).InstanceStore.Service
        const inst = yield* store.load({ directory: dir })
        const now = Date.now()
        yield* db.insert(ST).values({
          id: knownTarget as unknown as string,
          project_id: inst.project.id as unknown as string,
          workspace_id: null,
          parent_id: null,
          slug: "collision-slug",
          directory: dir,
          path: "path",
          title: "collision",
          version: "1",
          share_url: null,
          summary_additions: null,
          summary_deletions: null,
          summary_files: null,
          summary_diffs: null,
          metadata: null,
          cost: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          revert: null,
          permission: null,
          agent: null,
          model: null,
          revision: 0,
          time_created: now,
          time_updated: now,
          time_compacting: null,
          time_archived: null,
        } as unknown as typeof ST.$inferInsert).run().pipe(Effect.orDie)
        return dummy
      })))) as unknown as Effect.Effect<any, any, any>)
      ForkSeam.nextId = knownTarget as string
      const token = "coll-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-coll", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(res.status).toBe("failed")
      expect(res.failure.code).toBe("conflict")
      // ensure no FS files created for target
      const baseExists = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(knownTarget)).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false))) })))) as unknown as Effect.Effect<any, any, any>)
      expect(baseExists).toBe(false)
      const diffExists = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(["session_diff", knownTarget]).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false))) })))) as unknown as Effect.Effect<any, any, any>)
      expect(diffExists).toBe(false)
      const sandboxExists = yield* Effect.promise(() => SandboxStore.read(dir, knownTarget as unknown as SessionID).then((v) => !!v).catch(() => false))
      expect(sandboxExists).toBe(false)
      // source preserved
      const srcBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(source.id)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(srcBase).toEqual(diff)
      // cleanup: remove collision session row
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const { db } = yield* Database.Service; yield* db.delete(SessionTable).where(eq(SessionTable.id, knownTarget as unknown as SessionID)).run().pipe(Effect.orDie, Effect.catch(() => Effect.void)) })))) as unknown as Effect.Effect<any, any, any>)
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.remove(baseKey(source.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(["session_diff", source.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)) })))) as unknown as Effect.Effect<any, any, any>)
    }),
  )

  it.live("legacy Session.fork diff failure cleans owned session and leaves no ghost", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "legacy-src" }) })))) as unknown as Effect.Effect<any, any, any>)
      const diff = [{ file: "legacy.txt", patch: "diff", additions: 2, deletions: 0 } as unknown as any]
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.write(baseKey(source.id), diff); yield* s.write(["session_diff", source.id], diff) })))) as unknown as Effect.Effect<any, any, any>)
      const srcSandbox = { enabled: true, mode: "deny" as const, allowedHosts: [], writablePaths: ["/tmp"], version: 0 }
      yield* Effect.promise(() => SandboxStore.write(dir, source.id as unknown as SessionID, srcSandbox))
      const beforeList = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      const beforeCount = (beforeList as any[]).length
      ForkSeam.failFirstDiffWrite = true
      const forkExit = yield* Effect.exit(Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.fork({ sessionID: source.id as unknown as SessionID }) }))) as unknown as Effect.Effect<any, any, any>))
      ForkSeam.failFirstDiffWrite = false
      expect(forkExit._tag).toBe("Failure")
      const afterList = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((afterList as any[]).length).toBe(beforeCount)
      // ensure no ghost session was left (count unchanged)
      // retry without failure should succeed and create exactly one new session
      const forked = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.fork({ sessionID: source.id as unknown as SessionID }) })))) as unknown as Effect.Effect<any, any, any>)
      expect(forked.id).toBeDefined()
      expect(forked.id).not.toBe(source.id)
      const finalList = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((finalList as any[]).length).toBe(beforeCount + 1)
      // diff carried correctly on retry
      const targetBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(forked.id)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(targetBase).toEqual(diff)
      // cleanup
      yield* Effect.promise(() => SandboxStore.remove(dir, source.id as unknown as SessionID))
      yield* Effect.promise(() => SandboxStore.remove(dir, forked.id as unknown as SessionID).catch(() => undefined as void))
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.remove(baseKey(source.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(["session_diff", source.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(baseKey(forked.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(["session_diff", forked.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)) })))) as unknown as Effect.Effect<any, any, any>)
    }),
  )

  it.live("legacy late diff failure removes event aggregate, no artifacts/ghost, retry succeeds and preserves unrelated", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "legacy-late-src" }) })))) as unknown as Effect.Effect<any, any, any>)
      const unrelated = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "unrelated" }) })))) as unknown as Effect.Effect<any, any, any>)
      const diff = [{ file: "late.txt", patch: "diff-late", additions: 4, deletions: 1 } as unknown as any]
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.write(baseKey(source.id), diff); yield* s.write(["session_diff", source.id], diff) })))) as unknown as Effect.Effect<any, any, any>)
      const srcSandbox = { enabled: true, mode: "deny" as const, allowedHosts: [], writablePaths: ["/tmp"], version: 0 }
      yield* Effect.promise(() => SandboxStore.write(dir, source.id as unknown as SessionID, srcSandbox))
      const beforeList = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      const beforeCount = (beforeList as any[]).length
      // capture unrelated event aggregate existence
      const unrelatedSeqBefore = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, unrelated.id)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(unrelatedSeqBefore.length).toBe(1)
      const unrelatedEvtBefore = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, unrelated.id)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(unrelatedEvtBefore.length).toBe(1)
      const knownTarget = SessionID.descending()
      ForkSeam.nextId = knownTarget as string
      ForkSeam.failSecondDiffWrite = true
      const forkExit = yield* Effect.exit(Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.fork({ sessionID: source.id as unknown as SessionID }) }))) as unknown as Effect.Effect<any, any, any>))
      ForkSeam.failSecondDiffWrite = false
      ForkSeam.nextId = undefined
      expect(forkExit._tag).toBe("Failure")
      // no session row for target
      const targetRow = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionTable).where(eq(SessionTable.id, knownTarget as unknown as SessionID)).get().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(targetRow).toBeUndefined()
      // no EventSequence/EventTable aggregate for target
      const targetSeq = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, knownTarget)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(targetSeq.length).toBe(0)
      const targetEvt = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, knownTarget)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(targetEvt.length).toBe(0)
      // unrelated preserved
      const unrelatedSeqAfter = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, unrelated.id)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(unrelatedSeqAfter.length).toBe(1)
      const unrelatedEvtAfter = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, unrelated.id)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(unrelatedEvtAfter.length).toBe(1)
      // no artifacts
      const { storageFileForKey } = yield* Effect.promise(() => import("../../../src/storage/claimed-file"))
      const baseExists = yield* Effect.promise(() => fs.stat(storageFileForKey(baseKey(knownTarget))).then(() => true).catch(() => false))
      expect(baseExists).toBe(false)
      const diffExists = yield* Effect.promise(() => fs.stat(storageFileForKey(["session_diff", knownTarget])).then(() => true).catch(() => false))
      expect(diffExists).toBe(false)
      const storageBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(knownTarget)).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false))) })))) as unknown as Effect.Effect<any, any, any>)
      expect(storageBase).toBe(false)
      const storageDiff = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(["session_diff", knownTarget]).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false))) })))) as unknown as Effect.Effect<any, any, any>)
      expect(storageDiff).toBe(false)
      // no in-memory ghost
      expect(KiloSession.resolveParent(knownTarget as string)).toBeUndefined()
      const sandboxGhost = yield* Effect.promise(() => SandboxStore.read(dir, knownTarget as unknown as SessionID).then((v) => !!v).catch(() => false))
      expect(sandboxGhost).toBe(false)
      const afterList = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((afterList as any[]).length).toBe(beforeCount)
      // retry success
      const forked = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.fork({ sessionID: source.id as unknown as SessionID }) })))) as unknown as Effect.Effect<any, any, any>)
      expect(forked.id).toBeDefined()
      expect(forked.id).not.toBe(source.id)
      expect(forked.id).not.toBe(knownTarget)
      const finalList = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((finalList as any[]).length).toBe(beforeCount + 1)
      const retrySeq = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, forked.id)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(retrySeq.length).toBe(1)
      const retryEvt = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, forked.id)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(retryEvt.length).toBe(1)
      const targetBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(forked.id)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(targetBase).toEqual(diff)
      // cleanup
      yield* Effect.promise(() => SandboxStore.remove(dir, source.id as unknown as SessionID).catch(() => undefined as void))
      yield* Effect.promise(() => SandboxStore.remove(dir, forked.id as unknown as SessionID).catch(() => undefined as void))
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.remove(baseKey(source.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(["session_diff", source.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(baseKey(forked.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(["session_diff", forked.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)) })))) as unknown as Effect.Effect<any, any, any>)
    }),
  )

  it.live("write-after-claim failure cleans exact claimed path (claimed-file primitive)", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "src-claimed-fail" }) })))) as unknown as Effect.Effect<any, any, any>)
      const diff = [{ file: "c.txt", patch: "diff", additions: 3, deletions: 0 } as unknown as any]
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.write(baseKey(source.id), diff); yield* s.write(["session_diff", source.id], diff) })))) as unknown as Effect.Effect<any, any, any>)
      const knownTarget = SessionID.descending()
      ForkSeam.nextId = knownTarget as string
      ;(ForkSeam as unknown as { failClaimedWriteAfterOpen: boolean }).failClaimedWriteAfterOpen = true
      const token = "claimed-fail-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-claimed-fail", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      ;(ForkSeam as unknown as { failClaimedWriteAfterOpen: boolean }).failClaimedWriteAfterOpen = false
      expect(res.status).toBe("failed")
      // claimed file must have been cleaned (write failed after handle acquisition)
      const { storageFileForKey } = yield* Effect.promise(() => import("../../../src/storage/claimed-file"))
      const targetBasePath = storageFileForKey(baseKey(knownTarget))
      const targetDiffPath = storageFileForKey(["session_diff", knownTarget])
      const baseExists = yield* Effect.promise(() => fs.stat(targetBasePath).then(() => true).catch(() => false))
      const diffExists = yield* Effect.promise(() => fs.stat(targetDiffPath).then(() => true).catch(() => false))
      expect(baseExists).toBe(false)
      expect(diffExists).toBe(false)
      const srcBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(source.id)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(srcBase).toEqual(diff)
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).length).toBe(1)
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.remove(baseKey(source.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(["session_diff", source.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)) })))) as unknown as Effect.Effect<any, any, any>)
    }),
  )

  it.live("legacy preexisting sandbox/diff are preserved when fork conflicts before effects", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "legacy-preserve-src" }) })))) as unknown as Effect.Effect<any, any, any>)
      const srcDiff = [{ file: "src.txt", patch: "diff", additions: 1, deletions: 0 } as unknown as any]
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.write(baseKey(source.id), srcDiff); yield* s.write(["session_diff", source.id], srcDiff) })))) as unknown as Effect.Effect<any, any, any>)
      const srcSandbox = { enabled: true, mode: "deny" as const, allowedHosts: [], writablePaths: ["/tmp"], version: 0 }
      yield* Effect.promise(() => SandboxStore.write(dir, source.id as unknown as SessionID, srcSandbox))
      // pre-create target artifacts that must be preserved
      const knownTarget = SessionID.descending()
      const preBase = [{ file: "pre.txt", patch: "keep", additions: 9, deletions: 9 } as unknown as any]
      const preDiff = [{ file: "pre2.txt", patch: "keep2", additions: 5, deletions: 5 } as unknown as any]
      const { storageFileForKey } = yield* Effect.promise(() => import("../../../src/storage/claimed-file"))
      const { writeExclusiveJson } = yield* Effect.promise(() => import("../../../src/storage/claimed-file"))
      yield* Effect.promise(() => writeExclusiveJson(storageFileForKey(baseKey(knownTarget)), preBase))
      yield* Effect.promise(() => writeExclusiveJson(storageFileForKey(["session_diff", knownTarget]), preDiff))
      const preSandbox = { enabled: false, mode: "allow" as const, allowedHosts: [], writablePaths: ["/pre"], version: 0 }
      yield* Effect.promise(() => SandboxStore.writeExclusive(dir, knownTarget as unknown as SessionID, preSandbox))
      ForkSeam.nextId = knownTarget as string
      // Even with diff failure injection, fork must fail with conflict before overwriting preexisting and preserve them
      ForkSeam.failFirstDiffWrite = true
      const forkExit = yield* Effect.exit(Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.fork({ sessionID: source.id as unknown as SessionID }) }))) as unknown as Effect.Effect<any, any, any>))
      ForkSeam.failFirstDiffWrite = false
      expect(forkExit._tag).toBe("Failure")
      // preexisting preserved exactly
      const afterBase = yield* Effect.promise(() => fs.readFile(storageFileForKey(baseKey(knownTarget)), "utf8").then((t) => JSON.parse(t)).catch(() => undefined))
      expect(afterBase).toEqual(preBase)
      const afterDiff = yield* Effect.promise(() => fs.readFile(storageFileForKey(["session_diff", knownTarget]), "utf8").then((t) => JSON.parse(t)).catch(() => undefined))
      expect(afterDiff).toEqual(preDiff)
      const afterSandbox = yield* Effect.promise(() => SandboxStore.read(dir, knownTarget as unknown as SessionID))
      expect(afterSandbox).toEqual(preSandbox)
      // source preserved
      const srcBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(source.id)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(srcBase).toEqual(srcDiff)
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).length).toBe(1)
      expect((list as any[])[0].id).toBe(source.id)
      // cleanup preexisting target artifacts
      yield* Effect.promise(() => fs.rm(storageFileForKey(baseKey(knownTarget)), { force: true }))
      yield* Effect.promise(() => fs.rm(storageFileForKey(["session_diff", knownTarget]), { force: true }))
      yield* Effect.promise(() => SandboxStore.remove(dir, knownTarget as unknown as SessionID))
      yield* Effect.promise(() => SandboxStore.remove(dir, source.id as unknown as SessionID))
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.remove(baseKey(source.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(["session_diff", source.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)) })))) as unknown as Effect.Effect<any, any, any>)
    }),
  )

  it.live("legacy successful fork carries sandbox and diff with correct content", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "legacy-success-src" }) })))) as unknown as Effect.Effect<any, any, any>)
      const diff = [{ file: "succ.txt", patch: "diff-succ", additions: 7, deletions: 1 } as unknown as any]
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.write(baseKey(source.id), diff); yield* s.write(["session_diff", source.id], diff) })))) as unknown as Effect.Effect<any, any, any>)
      const srcSandbox = { enabled: true, mode: "proxy" as const, allowedHosts: ["example.com"], writablePaths: ["/tmp"], version: 0 }
      yield* Effect.promise(() => SandboxStore.write(dir, source.id as unknown as SessionID, srcSandbox))
      const beforeList = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      const beforeCount = (beforeList as any[]).length
      const forked = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.fork({ sessionID: source.id as unknown as SessionID }) })))) as unknown as Effect.Effect<any, any, any>)
      expect(forked.id).toBeDefined()
      expect(forked.id).not.toBe(source.id)
      expect(forked.title).toContain("(fork #")
      const afterList = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((afterList as any[]).length).toBe(beforeCount + 1)
      const targetBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(forked.id)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(targetBase).toEqual(diff)
      const targetDiff = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(["session_diff", forked.id]) })))) as unknown as Effect.Effect<any, any, any>)
      expect(targetDiff).toEqual(diff)
      const targetSandbox = yield* Effect.promise(() => SandboxStore.read(dir, forked.id as unknown as SessionID))
      expect(targetSandbox?.enabled).toBe(true)
      expect(targetSandbox?.mode).toBe("proxy")
      expect(targetSandbox?.allowedHosts).toEqual(["example.com"])
      expect(targetSandbox?.version).toBe(0)
      // cleanup
      yield* Effect.promise(() => SandboxStore.remove(dir, source.id as unknown as SessionID))
      yield* Effect.promise(() => SandboxStore.remove(dir, forked.id as unknown as SessionID).catch(() => undefined as void))
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.remove(baseKey(source.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(["session_diff", source.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(baseKey(forked.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(["session_diff", forked.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)) })))) as unknown as Effect.Effect<any, any, any>)
    }),
  )

  it.live("second diff failure with cleanup fs injection preserves original error, warns with target/cause, and retains owned file (no false success)", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "src-cleanup-fail" }) })))) as unknown as Effect.Effect<any, any, any>)
      const diff = [{ file: "cf.txt", patch: "diff", additions: 1, deletions: 0 } as unknown as any]
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.write(baseKey(source.id), diff); yield* s.write(["session_diff", source.id], diff) })))) as unknown as Effect.Effect<any, any, any>)
      const knownTarget = SessionID.descending()
      ForkSeam.nextId = knownTarget as string
      ForkSeam.failSecondDiffWrite = true
      ForkSeam.failCleanupFs = true
      ForkSeam.capturedCleanupWarnings.length = 0
      const token = "cleanup-fail-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-cleanup-fail", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      // original fork error preserved (second diff injected failure)
      expect(res.status).toBe("failed")
      expect(res.failure.code).toBe("internal")
      expect(res.failure.message).toContain("injected second diff write failure")
      // cleanup warning emitted with target/cause
      expect(ForkSeam.capturedCleanupWarnings.length).toBe(1)
      expect(ForkSeam.capturedCleanupWarnings[0].target).toContain(String(baseKey(knownTarget)[0]))
      expect(ForkSeam.capturedCleanupWarnings[0].cause).toContain("injected cleanup fs failure")
      // ownership retained: file remains (no false success clearing)
      const { storageFileForKey } = yield* Effect.promise(() => import("../../../src/storage/claimed-file"))
      const basePath = storageFileForKey(baseKey(knownTarget), Global.Path.data)
      const stillExists = yield* Effect.promise(() => fs.stat(basePath).then(() => true).catch(() => false))
      expect(stillExists).toBe(true)
      // no DB ghost, source preserved
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).length).toBe(1)
      expect((list as any[])[0].id).toBe(source.id)
      const targetRow = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* db.select().from(SessionTable).where(eq(SessionTable.id, knownTarget as unknown as SessionID)).get().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(targetRow).toBeUndefined()
      // reset seam and clean leftover owned file manually (since cleanup failed, file remains)
      ForkSeam.failSecondDiffWrite = false
      ForkSeam.failCleanupFs = false
      ForkSeam.capturedCleanupWarnings.length = 0
      ForkSeam.nextId = undefined
      yield* Effect.promise(() => fs.rm(basePath, { force: true }).catch(() => undefined as void))
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.remove(baseKey(source.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(["session_diff", source.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)) })))) as unknown as Effect.Effect<any, any, any>)
    }),
  )
})
