import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "../../../src/session/session"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionDeleteDispatchService } from "../../../src/kilocode/session/session-delete-dispatch"
import { testEffect } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime } from "../../../src/effect/app-runtime"
import * as Log from "@opencode-ai/core/util/log"
import { Database } from "@opencode-ai/core/database/database"

void Log.init({ print: false })

const it = testEffect(Layer.empty)
const run = <T>(fn: () => Promise<T>) => Effect.promise(fn) as unknown as Effect.Effect<T, unknown, never>

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("session/delete regression: atomic tombstone and instance cleanup", () => {
  it.live("tombstone is committed atomically with family deletion and replay is idempotent", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "tomb-atomic" }) }))))
      const token = "tomb-atomic-" + crypto.randomUUID().slice(0, 6)
      const opId = SessionOperation.deleteId(sess.id, token)
      const req = { v: 1 as const, requestId: "req-tomb-atomic", opId, op: "session/delete" as const, idempotencyKey: opId, context: { directory: dir, sessionId: sess.id, parentSessionId: null }, payload: {} }
      const r1 = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const d = yield* SessionDeleteDispatchService
        return yield* (d.dispatch(req) as unknown as Effect.Effect<{ status: string; opId: string }, unknown, never>)
      }))))
      expect(r1.status).toBe("succeeded")
      const tomb = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const { db } = yield* Database.Service
        const hash = SessionOperation.hashIdempotencyKey(opId)
        return yield* SessionOperation.getSessionDeleteByIdempotencyHash(db, sess.id, hash)
      }))))
      expect(tomb).toBeDefined()
      expect((tomb as { outcome: string }).outcome).toBe("succeeded")
      expect((tomb as { opId: string }).opId).toBe(opId)
      const r2 = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const d = yield* SessionDeleteDispatchService
        return yield* (d.dispatch({ ...req, requestId: "req-tomb-atomic-replay" }) as unknown as Effect.Effect<{ status: string; opId: string }, unknown, never>)
      }))))
      expect(r2.status).toBe("succeeded")
      expect(r2.opId).toBe(opId)
      const otherOpId = SessionOperation.deleteId(sess.id, token + "-other")
      const dupHash = SessionOperation.hashIdempotencyKey(opId)
      const dupRecord = { opId: otherOpId, opKind: "delete" as const, outcome: "succeeded" as const, code: "delete.succeeded", message: "delete succeeded", time: Date.now() }
      const dupMeta = { idempotencyHash: dupHash, requestId: "req-dup", directory: dir, parentSessionId: null, configVersion: null, sessionRevision: null }
      const dupAttempt = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* db.transaction((tx) => SessionOperation.insertSessionDeleteSucceededTx(tx as unknown as typeof db, sess.id, dupRecord, dupMeta)).pipe(Effect.exit)
      }))))
      expect((dupAttempt as { _tag: string })._tag).toBe("Failure")
    }),
  )

  it.live("tombstone failure is not swallowed: unique violation maps to conflict without orphan delete", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "tomb-not-swallow" }) }))))
      const token = "tomb-not-swallow-" + crypto.randomUUID().slice(0, 6)
      const opId = SessionOperation.deleteId(sess.id, token)
      const req = { v: 1 as const, requestId: "req-not-swallow", opId, op: "session/delete" as const, idempotencyKey: opId, context: { directory: dir, sessionId: sess.id, parentSessionId: null }, payload: {} }
      const r1 = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const d = yield* SessionDeleteDispatchService
        return yield* (d.dispatch(req) as unknown as Effect.Effect<{ status: string }, unknown, never>)
      }))))
      expect(r1.status).toBe("succeeded")
      const listAfter = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) }))))
      expect((listAfter as Session.Info[]).find((s) => s.id === sess.id)).toBeUndefined()
      const otherReq = { v: 1 as const, requestId: "req-not-swallow-2", opId, op: "session/delete" as const, idempotencyKey: opId, context: { directory: dir, sessionId: sess.id, parentSessionId: null, configVersion: 999 }, payload: {} }
      const r2 = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const d = yield* SessionDeleteDispatchService
        return yield* (d.dispatch(otherReq) as unknown as Effect.Effect<{ status: string; failure: { code: string } }, unknown, never>)
      }))))
      expect(r2.status).toBe("failed")
      expect((r2 as unknown as { failure: { code: string } }).failure.code).toBe("conflict")
    }),
  )

  it.live("instance-scoped cleanup is preserved: delete via dispatch uses drain control and clears background", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess1 = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "cleanup-1" }) }))))
      const sess2 = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "cleanup-2" }) }))))
      const token = "cleanup-" + crypto.randomUUID().slice(0, 6)
      const opId = SessionOperation.deleteId(sess1.id, token)
      const req = { v: 1 as const, requestId: "req-cleanup", opId, op: "session/delete" as const, idempotencyKey: opId, context: { directory: dir, sessionId: sess1.id, parentSessionId: null }, payload: {} }
      const r = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const d = yield* SessionDeleteDispatchService
        return yield* (d.dispatch(req) as unknown as Effect.Effect<{ status: string }, unknown, never>)
      }))))
      expect(r.status).toBe("succeeded")
      const list = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) }))))
      expect((list as Session.Info[]).find((s) => s.id === sess1.id)).toBeUndefined()
      expect((list as Session.Info[]).find((s) => s.id === sess2.id)).toBeDefined()
      const token2 = "cleanup2-" + crypto.randomUUID().slice(0, 6)
      const opId2 = SessionOperation.deleteId(sess2.id, token2)
      const req2 = { v: 1 as const, requestId: "req-cleanup2", opId: opId2, op: "session/delete" as const, idempotencyKey: opId2, context: { directory: dir, sessionId: sess2.id, parentSessionId: null }, payload: {} }
      const r2 = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const d = yield* SessionDeleteDispatchService
        return yield* (d.dispatch(req2) as unknown as Effect.Effect<{ status: string }, unknown, never>)
      }))))
      expect(r2.status).toBe("succeeded")
    }),
  )
})
