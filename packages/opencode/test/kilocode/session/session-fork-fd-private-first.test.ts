// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "../../../src/session/session"
import { SessionID } from "../../../src/session/schema"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionForkDispatchService } from "../../../src/kilocode/session/session-fork-dispatch"
import { testEffect } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime } from "../../../src/effect/app-runtime"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

const it = testEffect(Layer.empty)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("FD session/fork commits via dispatch (authoritative)", () => {
  it.live("same-tuple replay returns same forked session without duplicate", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source" }) })))) as unknown as Effect.Effect<any, any, any>)
      const token = "fd-fork-" + Math.random().toString(36).slice(2, 8)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-fd-fork", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r1.status).toBe("succeeded")
      expect(r1.accepted).toBeTrue()
      const forkedId = r1.data.id
      expect(typeof forkedId).toBe("string")
      expect(r1.data.parentID).toBe(source.id)
      const r2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch({ ...req, requestId: "req-fd-fork-replay" }) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r2.status).toBe("succeeded")
      expect(r2.data.id).toBe(forkedId)
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).filter((s) => s.parentID === source.id).length).toBe(1)
    }),
  )

  it.live("missing source closes with session.not_found and creates nothing", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const missing = SessionID.descending()
      const token = "tok-missing"
      const req = { v: 1 as const, requestId: "req-fd-fork-missing", opId: `fork:${missing}:${token}`, op: "session/fork" as const, idempotencyKey: `fork:${missing}:${token}`, context: { directory: dir, sessionId: missing, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(res.status).toBe("failed")
      expect(res.accepted).toBeFalse()
      expect(res.failure.code).toBe("session.not_found")
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).filter((s) => (s as { directory: string }).directory === dir).length).toBe(0)
    }),
  )
})
