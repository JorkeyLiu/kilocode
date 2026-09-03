// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { Session } from "../../../src/session/session"
import { SessionID } from "../../../src/session/schema"
import { SessionForkDispatchService } from "../../../src/kilocode/session/session-fork-dispatch"
import { testEffect } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { AppLayer } from "../../../src/effect/app-runtime"
import { InstanceStore } from "../../../src/project/instance-store"
import { InstanceRef } from "../../../src/effect/instance-ref"
import { runInInstance } from "../../../src/kilocode/effect/als-bridge"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

const it = testEffect(AppLayer)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("sessionFork colon durable parity", () => {
  it.live("colon-containing source SessionID fork succeeds durably with canonical identity and replay", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const store = yield* InstanceStore.Service as unknown as Effect.Effect<any, any, any>
      const ctx = (yield* (store.load({ directory: dir }) as unknown as Effect.Effect<any, any, any>) as unknown as Effect.Effect<any, any, any>) as any
      const captured = yield* Effect.context() as unknown as Effect.Effect<any, any, any>
      const run = ((work: Effect.Effect<any, any, any>) =>
        runInInstance(
          ctx,
          (work.pipe(
            Effect.provide(captured as never),
            Effect.provideService(InstanceRef, ctx),
          ) as unknown as Effect.Effect<any, any, never>),
        )) as unknown as (work: Effect.Effect<any, any, any>) => Effect.Effect<any, any, any>
      const seed = yield* run(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "seed" }) }) as unknown as Effect.Effect<any, any, any>)
      const suffix = Math.random().toString(36).slice(2, 8)
      const colonId = `ses:colon:${Date.now().toString(36)}${suffix}`
      // SessionID grammar accepts colon form (startsWith ses); request validation relies on this.
      SessionID.make(colonId)
      const now = Date.now()
      yield* run(Effect.gen(function* () {
        const { db } = yield* Database.Service
        const { SessionTable: T } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
        const { eq: eqq } = yield* Effect.promise(() => import("drizzle-orm"))
        const seedRow = yield* db.select().from(T).where(eqq(T.id, seed.id)).get().pipe(Effect.orDie)
        if (!seedRow) throw new Error("seed session row missing")
        const s = seedRow as unknown as Record<string, unknown>
        const colonRow = {
          ...s,
          id: colonId,
          parent_id: null,
          slug: `${s.slug as string}-colon-${suffix}`,
          title: "colon-source",
          revision: 0,
          time_created: now,
          time_updated: now,
        }
        yield* db.insert(T).values(colonRow as unknown as typeof T.$inferInsert).run().pipe(Effect.orDie)
      }) as unknown as Effect.Effect<any, any, any>)
      const token = "tok-" + Math.random().toString(36).slice(2, 8)
      const opId = `fork:${colonId}:${token}`
      const req = { v: 1 as const, requestId: "req-colon-durable", opId, op: "session/fork" as const, idempotencyKey: opId, context: { directory: dir, sessionId: colonId, parentSessionId: null }, payload: {} }
      const res = yield* run(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) }) as unknown as Effect.Effect<any, any, any>)
      expect(res.status).toBe("succeeded")
      expect(res.opId).toBe(opId)
      expect(res.idempotencyKey).toBe(opId)
      expect(res.data.id).toBeDefined()
      expect(res.data.parentID).toBe(colonId)
      expect(res.data.directory).toBe(dir)
      const forkedId = res.data.id as string
      // persisted canonical operation identity under colon source session
      const opRows = yield* run(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); return yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, colonId as unknown as SessionID)).all().pipe(Effect.orDie) }) as unknown as Effect.Effect<any, any, any>)
      const forks = (opRows as any[]).filter((r) => r.op_kind === "fork")
      expect(forks.length).toBe(1)
      expect(forks[0].op_id).toBe(opId)
      expect(forks[0].idempotency_hash).toBe(SessionOperation.hashIdempotencyKey(opId))
      expect(forks[0].directory).toBe(dir)
      expect(forks[0].result_snapshot).toBeDefined()
      // replay with identical canonical identity returns same forked session without duplicate
      const r2 = yield* run(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) }) as unknown as Effect.Effect<any, any, any>)
      expect(r2.status).toBe("succeeded")
      expect(r2.data.id).toBe(forkedId)
      expect(r2.opId).toBe(opId)
      expect(r2.idempotencyKey).toBe(opId)
      const opRows2 = yield* run(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); return yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, colonId as unknown as SessionID)).all().pipe(Effect.orDie) }) as unknown as Effect.Effect<any, any, any>)
      expect((opRows2 as any[]).filter((r) => r.op_kind === "fork").length).toBe(1)
      const list = yield* run(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) }) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).filter((s) => s.parentID === colonId).length).toBe(1)
    }),
  )
})
