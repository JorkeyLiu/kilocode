// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { Session } from "../../../src/session/session"
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
import { SessionID } from "../../../src/session/schema"

void Log.init({ print: false })

const it = testEffect(Layer.empty)

afterEach(async () => {
  ForkSeam.nextId = undefined
  ForkSeam.failSecondDiffWrite = false
  ForkSeam.failFirstDiffWrite = false
  ForkSeam.failSandboxWrite = false
  ForkSeam.failTxAfterFs = false
  await disposeAllInstances()
  await resetDatabase()
})

describe("sessionFork persistence boundary", () => {
  it.live("success carries diff and replay returns same fork without duplicate side effects", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source-diff" }) })))) as unknown as Effect.Effect<any, any, any>)
      const diff = [{ file: "a.txt", patch: "diff", additions: 1, deletions: 0 } as unknown as any]
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const storage = yield* Storage.Service; yield* storage.write(["session_diff", source.id], diff); yield* storage.write(baseKey(source.id), diff) })))) as unknown as Effect.Effect<any, any, any>)
      const token = "persist-ok-" + Math.random().toString(36).slice(2, 8)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-persist-ok", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(res.status).toBe("succeeded")
      const forkedId = res.data.id
      const targetBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const storage = yield* Storage.Service; return yield* storage.read<any>(baseKey(forkedId)).pipe(Effect.catch(() => Effect.succeed(null as any)), Effect.catchDefect(() => Effect.succeed(null as any))) })))) as unknown as Effect.Effect<any, any, any>)
      const targetDiff = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const storage = yield* Storage.Service; return yield* storage.read<any>(["session_diff", forkedId]).pipe(Effect.catch(() => Effect.succeed(null as any)), Effect.catchDefect(() => Effect.succeed(null as any))) })))) as unknown as Effect.Effect<any, any, any>)
      expect(targetBase).toEqual(diff)
      expect(targetDiff).toEqual(diff)
      const res2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(res2.status).toBe("succeeded")
      expect(res2.data.id).toBe(forkedId)
      const priv = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* (d as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(priv.status).toBe("succeeded")
      const privId = (priv.data as { id?: string; session?: { id: string } }).session?.id ?? (priv.data as { id?: string }).id
      expect(privId).toBe(forkedId)
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).filter((s) => s.parentID === source.id).length).toBe(1)
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const storage = yield* Storage.Service; yield* storage.remove(baseKey(source.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* storage.remove(["session_diff", source.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* storage.remove(baseKey(forkedId)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* storage.remove(["session_diff", forkedId]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)) })))) as unknown as Effect.Effect<any, any, any>)
    }),
  )

  it.live("diff read failure propagates as fork failure and leaves no DB/filesystem/in-memory ghost", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source-read-fail" }) })))) as unknown as Effect.Effect<any, any, any>)
      const { Global } = yield* Effect.promise(() => import("@opencode-ai/core/global"))
      const fs = yield* Effect.promise(() => import("node:fs/promises"))
      const path = yield* Effect.promise(() => import("node:path"))
      const storageDir = path.join(Global.Path.data, "storage", "session_diff")
      yield* Effect.promise(() => fs.mkdir(storageDir, { recursive: true }))
      const badPath = path.join(storageDir, `${source.id}.json`)
      yield* Effect.promise(() => fs.rm(badPath, { force: true, recursive: true }))
      yield* Effect.promise(() => fs.mkdir(badPath, { recursive: true }))
      const baseDir = path.join(Global.Path.data, "storage", "session_diff_base")
      yield* Effect.promise(() => fs.mkdir(baseDir, { recursive: true }))
      const badBase = path.join(baseDir, `${source.id}.json`)
      yield* Effect.promise(() => fs.rm(badBase, { force: true, recursive: true }))
      yield* Effect.promise(() => fs.mkdir(badBase, { recursive: true }))

      const beforeList = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      const beforeCount = (beforeList as any[]).length
      const beforeOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)

      const token = "read-fail-" + Math.random().toString(36).slice(2, 8)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-read-fail", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(res.status).toBe("failed")
      expect(res.failure.code).toBe("internal")
      // DB rollback: no new session, no new operation
      const afterList = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((afterList as any[]).length).toBe(beforeCount)
      const afterOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect((afterOps as any[]).length).toBe((beforeOps as any[]).length)
      const opRow = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* SessionOperation.get(db, opId).pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(opRow).toBeUndefined()
      // no in-memory ghost
      expect(KiloSession.resolveParent(source.id)).toBeUndefined()
      // private replay also fails closed (no committed record)
      const priv = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* (d as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(priv.status).toBe("failed")
      yield* Effect.promise(() => fs.rm(badPath, { force: true, recursive: true }))
      yield* Effect.promise(() => fs.rm(badBase, { force: true, recursive: true }))
    }),
  )

  it.live("second target write failure via dispatch fails closed and cleans owned artifacts (deterministic injection)", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source-write-fail" }) })))) as unknown as Effect.Effect<any, any, any>)
      const diff = [{ file: "b.txt", patch: "diff2", additions: 1, deletions: 0 } as unknown as any]
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.write(baseKey(source.id), diff); yield* s.write(["session_diff", source.id], diff) })))) as unknown as Effect.Effect<any, any, any>)
      const beforeList = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      const beforeCount = (beforeList as any[]).length
      const beforeOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      const knownTarget = SessionID.descending()
      ForkSeam.nextId = knownTarget as string
      ForkSeam.failSecondDiffWrite = true
      const token = "write-fail-" + Math.random().toString(36).slice(2, 8)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-write-fail", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      ForkSeam.failSecondDiffWrite = false
      expect(res.status).toBe("failed")
      expect(res.failure.code).toBe("internal")
      // DB rollback: no new session
      const afterList = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((afterList as any[]).length).toBe(beforeCount)
      const afterOps = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); return yield* db.select().from(SessionOperationTable).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect((afterOps as any[]).length).toBe((beforeOps as any[]).length)
      const opRow = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* SessionOperation.get(db, opId).pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(opRow).toBeUndefined()
      // filesystem cleanup: exact target paths must not exist, source preserved
      const targetBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(knownTarget)).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false))) })))) as unknown as Effect.Effect<any, any, any>)
      const targetDiff = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(["session_diff", knownTarget]).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false))) })))) as unknown as Effect.Effect<any, any, any>)
      expect(targetBase).toBe(false)
      expect(targetDiff).toBe(false)
      const sourceBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(source.id)).pipe(Effect.map((v) => v), Effect.catch(() => Effect.succeed(null)), Effect.catchDefect(() => Effect.succeed(null))) })))) as unknown as Effect.Effect<any, any, any>)
      expect(sourceBase).toEqual(diff)
      // no in-memory ghost
      expect(KiloSession.resolveParent(source.id)).toBeUndefined()
      const priv = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* (d as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(priv.status).toBe("failed")
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.remove(baseKey(source.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(["session_diff", source.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)) })))) as unknown as Effect.Effect<any, any, any>)
    }),
  )

  it.live("pre-existing target artifacts are rejected not deleted (fail closed, ownership)", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source-preexist" }) })))) as unknown as Effect.Effect<any, any, any>)
      const sourceDiff = [{ file: "pre.txt", patch: "src", additions: 1, deletions: 0 } as unknown as any]
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.write(["session_diff", source.id], sourceDiff); yield* s.write(baseKey(source.id), sourceDiff) })))) as unknown as Effect.Effect<any, any, any>)
      const knownTarget = SessionID.descending()
      const preDiff = [{ file: "evil.txt", patch: "evil", additions: 99, deletions: 99 } as unknown as any]
      const preBase = [{ file: "evil-base.txt", patch: "evil-base", additions: 9, deletions: 9 } as unknown as any]
      // pre-create target artifacts with distinct content
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.write(["session_diff", knownTarget], preDiff); yield* s.write(baseKey(knownTarget), preBase) })))) as unknown as Effect.Effect<any, any, any>)
      // also pre-create sandbox for target
      const preSandbox = { enabled: true, mode: "deny" as const, allowedHosts: [], writablePaths: ["/tmp"], version: 0 }
      yield* Effect.promise(() => SandboxStore.write(dir, knownTarget as unknown as SessionID, preSandbox))
      ForkSeam.nextId = knownTarget as string
      const token = "preexist-" + Math.random().toString(36).slice(2, 8)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-preexist", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(res.status).toBe("failed")
      expect(res.failure.code).toBe("conflict")
      // verify pre-existing artifacts preserved exactly (not deleted, not overwritten)
      const afterDiff = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(["session_diff", knownTarget]) })))) as unknown as Effect.Effect<any, any, any>)
      const afterBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(knownTarget)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(afterDiff).toEqual(preDiff)
      expect(afterBase).toEqual(preBase)
      const afterSandbox = yield* Effect.promise(() => SandboxStore.read(dir, knownTarget as unknown as SessionID))
      expect(afterSandbox).toEqual(preSandbox)
      // no DB mutation
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).length).toBe(1)
      expect((list as any[])[0].id).toBe(source.id)
      const opRow = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* SessionOperation.get(db, opId).pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(opRow).toBeUndefined()
      // cleanup pre-existing target
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.remove(["session_diff", knownTarget]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(baseKey(knownTarget)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)) })))) as unknown as Effect.Effect<any, any, any>)
      yield* Effect.promise(() => SandboxStore.remove(dir, knownTarget as unknown as SessionID))
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.remove(baseKey(source.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(["session_diff", source.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)) })))) as unknown as Effect.Effect<any, any, any>)
    }),
  )

  it.live("later transaction failure after FS writes cleans only owned artifacts (sandbox+diff)", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source-tx-fail" }) })))) as unknown as Effect.Effect<any, any, any>)
      const diff = [{ file: "c.txt", patch: "diff3", additions: 1, deletions: 0 } as unknown as any]
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.write(["session_diff", source.id], diff); yield* s.write(baseKey(source.id), diff) })))) as unknown as Effect.Effect<any, any, any>)
      // Ensure source has sandbox so inherit will create target sandbox
      // Source's sandbox is created via snapshot initialization path: toggle or via direct write
      // We manually write a sandbox for source to ensure inherit creates target
      const srcSandbox = { enabled: true, mode: "deny" as const, allowedHosts: [], writablePaths: ["/tmp"], version: 0 }
      yield* Effect.promise(() => SandboxStore.write(dir, source.id as unknown as SessionID, srcSandbox))
      const knownTarget = SessionID.descending()
      ForkSeam.nextId = knownTarget as string
      ForkSeam.failTxAfterFs = true
      const token = "tx-fail-" + Math.random().toString(36).slice(2, 8)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-tx-fail", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      ForkSeam.failTxAfterFs = false
      expect(res.status).toBe("failed")
      expect(res.failure.code).toBe("internal")
      // owned artifacts must be removed
      const targetBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(knownTarget)).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false))) })))) as unknown as Effect.Effect<any, any, any>)
      const targetDiff = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(["session_diff", knownTarget]).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false))) })))) as unknown as Effect.Effect<any, any, any>)
      expect(targetBase).toBe(false)
      expect(targetDiff).toBe(false)
      const targetSandbox = yield* Effect.promise(() => SandboxStore.read(dir, knownTarget as unknown as SessionID).then((v) => !!v).catch(() => false))
      expect(targetSandbox).toBe(false)
      // source preserved
      const sourceBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(source.id)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(sourceBase).toEqual(diff)
      // DB: no forked session, no operation
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).length).toBe(1)
      expect((list as any[])[0].id).toBe(source.id)
      const opRow = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; return yield* SessionOperation.get(db, opId).pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect(opRow).toBeUndefined()
      expect(KiloSession.resolveParent(knownTarget as string)).toBeUndefined()
      // unrelated pre-existing artifact must not be deleted: create another session's diff as control
      // (we already verified target removed, source kept)
      yield* Effect.promise(() => SandboxStore.remove(dir, source.id as unknown as SessionID))
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; yield* s.remove(baseKey(source.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)); yield* s.remove(["session_diff", source.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)) })))) as unknown as Effect.Effect<any, any, any>)
    }),
  )

  it.live("sandbox write then DB failure leaves no sandbox ghost", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source-sandbox-fail" }) })))) as unknown as Effect.Effect<any, any, any>)
      const srcSandbox = { enabled: true, mode: "allow" as const, allowedHosts: [], writablePaths: ["/tmp"], version: 0 }
      yield* Effect.promise(() => SandboxStore.write(dir, source.id as unknown as SessionID, srcSandbox))
      const knownTarget = SessionID.descending()
      ForkSeam.nextId = knownTarget as string
      ForkSeam.failTxAfterFs = true
      const token = "sandbox-fail-" + Math.random().toString(36).slice(2, 8)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-sandbox-fail", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      ForkSeam.failTxAfterFs = false
      expect(res.status).toBe("failed")
      const afterSandbox = yield* Effect.promise(() => SandboxStore.read(dir, knownTarget as unknown as SessionID))
      expect(afterSandbox).toBeUndefined()
      const targetBase = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const s = yield* Storage.Service; return yield* s.read<any>(baseKey(knownTarget)).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false))) })))) as unknown as Effect.Effect<any, any, any>)
      expect(targetBase).toBe(false)
      yield* Effect.promise(() => SandboxStore.remove(dir, source.id as unknown as SessionID))
    }),
  )

  it.live("failed fork leaves no in-memory or sandbox ghost", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source-ghost" }) })))) as unknown as Effect.Effect<any, any, any>)
      const token = "ghost-" + Math.random().toString(36).slice(2, 8)
      const opId = SessionOperation.forkId(source.id, token)
      const badReq = { v: 1 as const, requestId: "req-ghost", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: "relative/path", sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(badReq) })))) as unknown as Effect.Effect<any, any, any>)
      expect(res.status).toBe("failed")
      expect(res.failure.code).toBe("validation.failed")
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).length).toBe(1)
      expect((list as any[])[0].id).toBe(source.id)
      expect(KiloSession.resolveParent(source.id)).toBeUndefined()
      const priv = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* (d as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate(badReq) })))) as unknown as Effect.Effect<any, any, any>)
      expect(priv.status).toBe("failed")
      const list2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list2 as any[]).length).toBe(1)
    }),
  )

  it.live("fork idempotency helpers scope only fork records (cross-kind collision regression)", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source-cross-kind" }) })))) as unknown as Effect.Effect<any, any, any>)
      const token = "cross-kind-" + Math.random().toString(36).slice(2, 6)
      const hash = SessionOperation.hashIdempotencyKey(`fork:${source.id}:${token}`)
      const opIdFork = SessionOperation.forkId(source.id, token)
      // Insert a non-fork operation with same hash (simulate cross-kind collision)
      const otherOpId = SessionOperation.createId(token)
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const { db } = yield* Database.Service
        const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
        // Insert a create operation with same hash but different op_kind
        yield* db.insert(SessionOperationTable).values({
          op_id: otherOpId,
          session_id: source.id,
          op_kind: "create",
          outcome: "succeeded",
          code: "create.succeeded",
          message: "create succeeded",
          time: Date.now(),
          revision: 0,
          idempotency_hash: hash,
          request_id: "req-cross-kind",
          directory: dir,
          title: "dummy",
        } as any).run().pipe(Effect.orDie)
      })))) as unknown as Effect.Effect<any, any, any>)
      // Fork helper must NOT return the create record (op_kind filter)
      const viaFork = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* SessionOperation.getSessionForkByIdempotencyHash(db, source.id as any, hash).pipe(Effect.orDie)
      })))) as unknown as Effect.Effect<any, any, any>)
      expect(viaFork).toBeUndefined()
      const viaForkTx = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* db.transaction((tx) => SessionOperation.getSessionForkByIdempotencyHashTx(tx as any, source.id as any, hash)).pipe(Effect.orDie)
      })))) as unknown as Effect.Effect<any, any, any>)
      expect(viaForkTx).toBeUndefined()
      // Remove the cross-kind create record, then fork with same hash should succeed (proves helper correctly ignored create, and fork insert not blocked by stale cross-kind row)
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const { db } = yield* Database.Service
        const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
        yield* db.delete(SessionOperationTable).where(eq(SessionOperationTable.op_id, otherOpId)).run().pipe(Effect.orDie)
      })))) as unknown as Effect.Effect<any, any, any>)
      const req = { v: 1 as const, requestId: "req-cross-kind-fork", opId: opIdFork, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(res.status).toBe("succeeded")
      // Cleanup forked session artifacts
      const forkedId = res.data.id
      yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const s = yield* Storage.Service
        yield* s.remove(baseKey(source.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
        yield* s.remove(["session_diff", source.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
        yield* s.remove(baseKey(forkedId)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
        yield* s.remove(["session_diff", forkedId]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
      })))) as unknown as Effect.Effect<any, any, any>)
    }),
  )
})
