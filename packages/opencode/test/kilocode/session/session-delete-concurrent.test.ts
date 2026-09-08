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
import * as Retention from "@opencode-ai/core/retention/retention"

void Log.init({ print: false })

const it = testEffect(Layer.empty)

const run = <T>(fn: () => Promise<T>) => Effect.promise(fn) as unknown as Effect.Effect<T, unknown, never>

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("session/delete concurrent disappearance", () => {
  it.live("atomic helper empty family must not produce success", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "concurrent-empty" }) }))))
      yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.remove(sess.id) }))))
      const opId = SessionOperation.deleteId(sess.id, "concurrent-token")
      const hash = SessionOperation.hashIdempotencyKey(opId)
      const exit = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* Retention.deleteFamilyWithDeleteTombstoneUnprotected(db, sess.id, Date.now(), {
          opId,
          sessionId: sess.id,
          hash,
          requestId: "req-concurrent-empty",
          directory: dir,
          parentSessionId: null,
          configVersion: null,
          sessionRevision: null,
          time: Date.now(),
          code: "delete.succeeded",
          message: "delete succeeded",
        }).pipe(Effect.exit)
      }))))
      expect(exit._tag).toBe("Failure")
      const causeStr = String((exit as { cause: unknown }).cause)
      expect(causeStr).toContain("family not found")
    }),
  )

  it.live("dispatch must not return succeeded when family disappeared after precheck (concurrent legacy delete)", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "concurrent-dispatch" }) }))))
      const opId = SessionOperation.deleteId(sess.id, "concurrent-dispatch-token")
      const req = { v: 1 as const, requestId: "req-concurrent-dispatch", opId, op: "session/delete" as const, idempotencyKey: opId, context: { directory: dir, sessionId: sess.id, parentSessionId: null }, payload: {} }
      yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.remove(sess.id) }))))
      const result = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const d = yield* SessionDeleteDispatchService
        return yield* (d.dispatch(req) as unknown as Effect.Effect<{ status: string; failure: { code: string }; accepted: boolean }, unknown, never>)
      }))))
      expect(result.status).toBe("failed")
      expect((result as unknown as { failure: { code: string } }).failure.code).toBe("session.not_found")
      expect(result.status).not.toBe("succeeded")
      const tomb = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const { db } = yield* Database.Service
        const hash = SessionOperation.hashIdempotencyKey(opId)
        return yield* SessionOperation.getSessionDeleteByIdempotencyHash(db, sess.id, hash)
      }))))
      expect(tomb === undefined || (tomb as { outcome: string }).outcome !== "succeeded").toBeTrue()
    }),
  )

  it.live("dispatch after successful delete does not fabricate success for missing family", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "concurrent-no-fabricate" }) }))))
      const opId = SessionOperation.deleteId(sess.id, "no-fabricate-token")
      const req = { v: 1 as const, requestId: "req-no-fabricate", opId, op: "session/delete" as const, idempotencyKey: opId, context: { directory: dir, sessionId: sess.id, parentSessionId: null }, payload: {} }
      const r1 = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const d = yield* SessionDeleteDispatchService
        return yield* (d.dispatch(req) as unknown as Effect.Effect<{ status: string }, unknown, never>)
      }))))
      expect(r1.status).toBe("succeeded")
      const r2 = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const d = yield* SessionDeleteDispatchService
        return yield* (d.dispatch({ ...req, requestId: "req-no-fabricate-2" }) as unknown as Effect.Effect<{ status: string }, unknown, never>)
      }))))
      expect(r2.status).toBe("succeeded")
      const opId2 = SessionOperation.deleteId(sess.id, "no-fabricate-token2")
      const req2 = { v: 1 as const, requestId: "req-no-fabricate-3", opId: opId2, op: "session/delete" as const, idempotencyKey: opId2, context: { directory: dir, sessionId: sess.id, parentSessionId: null }, payload: {} }
      const r3 = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const d = yield* SessionDeleteDispatchService
        return yield* (d.dispatch(req2) as unknown as Effect.Effect<{ status: string; failure: { code: string } }, unknown, never>)
      }))))
      expect(r3.status).toBe("failed")
      expect((r3 as unknown as { failure: { code: string } }).failure.code).toBe("session.not_found")
    }),
  )
})
