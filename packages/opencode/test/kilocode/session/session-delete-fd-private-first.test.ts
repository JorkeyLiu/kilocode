import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "../../../src/session/session"
import { SessionID } from "../../../src/session/schema"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionDeleteDispatchService } from "../../../src/kilocode/session/session-delete-dispatch"
import { testEffect } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime } from "../../../src/effect/app-runtime"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

const it = testEffect(Layer.empty)
const run = <T>(fn: () => Promise<T>) => Effect.promise(fn) as unknown as Effect.Effect<T, unknown, never>

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("FD session/delete commits via dispatch (authoritative)", () => {
  it.live("same-tuple replay returns same succeeded without duplicate side effects", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "to-delete" }) }))))
      const token = "fd-del-" + crypto.randomUUID().slice(0, 8)
      const opId = SessionOperation.deleteId(sess.id, token)
      const req = { v: 1 as const, requestId: "req-fd-del", opId, op: "session/delete" as const, idempotencyKey: opId, context: { directory: dir, sessionId: sess.id, parentSessionId: null }, payload: {} }
      const r1 = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const d = yield* SessionDeleteDispatchService
        return yield* (d.dispatch(req) as unknown as Effect.Effect<{ status: string; accepted: boolean; opId: string }, unknown, never>)
      }))))
      expect(r1.status).toBe("succeeded")
      expect(r1.accepted).toBeTrue()
      const listAfter1 = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) }))))
      expect((listAfter1 as Session.Info[]).find((s) => s.id === sess.id)).toBeUndefined()
      const r2 = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const d = yield* SessionDeleteDispatchService
        return yield* (d.dispatch({ ...req, requestId: "req-fd-del-replay" }) as unknown as Effect.Effect<{ status: string; accepted: boolean; opId: string }, unknown, never>)
      }))))
      expect(r2.status).toBe("succeeded")
      expect(r2.accepted).toBeTrue()
      expect(r2.opId).toBe(opId)
      const listAfter2 = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) }))))
      expect((listAfter2 as Session.Info[]).find((s) => s.id === sess.id)).toBeUndefined()
    }),
  )

  it.live("missing session closes with session.not_found and deletes nothing", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const missing = SessionID.descending()
      const token = "tok-missing"
      const opId = SessionOperation.deleteId(missing, token)
      const req = { v: 1 as const, requestId: "req-fd-del-missing", opId, op: "session/delete" as const, idempotencyKey: opId, context: { directory: dir, sessionId: missing, parentSessionId: null }, payload: {} }
      const res = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const d = yield* SessionDeleteDispatchService
        return yield* (d.dispatch(req) as unknown as Effect.Effect<{ status: string; accepted: boolean; failure: { code: string } }, unknown, never>)
      }))))
      expect(res.status).toBe("failed")
      expect((res as unknown as { failure: { code: string } }).failure.code).toBe("session.not_found")
      const list = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) }))))
      expect((list as Session.Info[]).filter((s) => s.directory === dir).length).toBe(0)
    }),
  )

  it.live("strict validation rejects omitted parentSessionId without mutation", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const sess = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "strict-del" }) }))))
      const token = "strict-" + crypto.randomUUID().slice(0, 8)
      const opId = SessionOperation.deleteId(sess.id, token)
      const req = { v: 1 as const, requestId: "req-fd-del-strict", opId, op: "session/delete" as const, idempotencyKey: opId, context: { directory: dir, sessionId: sess.id }, payload: {} } as unknown as Record<string, unknown>
      const res = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const d = yield* SessionDeleteDispatchService
        return yield* (d.dispatch(req) as unknown as Effect.Effect<{ status: string; failure: { code: string } }, unknown, never>)
      }))))
      expect(res.status).toBe("failed")
      expect((res as unknown as { failure: { code: string } }).failure.code).toBe("validation.failed")
      const still = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.get(sess.id) }))))
      expect(still.id).toBe(sess.id)
    }),
  )

  it.live("scope mismatch returns scope_mismatch without deletion", () =>
    Effect.gen(function* () {
      const tmp = yield* run(() => tmpdir({ git: true }))
      const dir = tmp.path
      const other = yield* run(() => tmpdir({ git: true }))
      const otherDir = other.path
      const sess = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "scope-del" }) }))))
      const token = "scope-" + crypto.randomUUID().slice(0, 8)
      const opId = SessionOperation.deleteId(sess.id, token)
      const req = { v: 1 as const, requestId: "req-fd-del-scope", opId, op: "session/delete" as const, idempotencyKey: opId, context: { directory: otherDir, sessionId: sess.id, parentSessionId: null }, payload: {} }
      const res = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () {
        const d = yield* SessionDeleteDispatchService
        return yield* (d.dispatch(req) as unknown as Effect.Effect<{ status: string; failure: { code: string } }, unknown, never>)
      }))))
      expect(res.status).toBe("failed")
      expect((res as unknown as { failure: { code: string } }).failure.code).toBe("scope_mismatch")
      const still = yield* run(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.get(sess.id) }))))
      expect(still.id).toBe(sess.id)
    }),
  )
})
