// @ts-nocheck
// Classified production-runtime integration boundary (see script/check-opencode-promise-facades.ts):
// B3 fork directory-scope durable dispatch via the canonical runtime + InstanceRef.
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import * as fs from "node:fs"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { Session } from "../../../src/session/session"
import { SessionID } from "../../../src/session/schema"
import { SessionForkDispatchService } from "../../../src/kilocode/session/session-fork-dispatch"
import { testEffect } from "../../lib/effect"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, provideInstance, tmpdir } from "../../fixture/fixture"
import { AppRuntime } from "../../../src/effect/app-runtime"
import { Storage } from "../../../src/storage/storage"
import { baseKey } from "../../../src/kilocode/session-portability/cumulative-diff"
import { SandboxStore } from "../../../src/kilocode/sandbox/store"
import { ForkSeam } from "../../../src/kilocode/session/fork-seam"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

const it = testEffect(Layer.empty)

afterEach(async () => {
  ForkSeam.nextId = undefined
  ForkSeam.failFirstDiffWrite = false
  ForkSeam.failSecondDiffWrite = false
  ForkSeam.failSandboxWrite = false
  ForkSeam.failTxAfterFs = false
  ForkSeam.failCleanupFs = false
  ForkSeam.failCleanupStorage = false
  ForkSeam.capturedCleanupWarnings.length = 0
  await disposeAllInstances()
  await resetDatabase()
})

describe("sessionFork directory scope", () => {
  it.live("cross-directory A source -> B fork fails scope_mismatch with no child/messages/sandbox copy", () =>
    Effect.gen(function* () {
      const tmpA = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as any)
      const tmpB = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as any)
      const dirA = fs.realpathSync(tmpA.path)
      const dirB = fs.realpathSync(tmpB.path)
      expect(dirA).not.toBe(dirB)
      const source = yield* (Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dirA)(
            Effect.gen(function* () {
              const svc = yield* Session.Service
              return yield* svc.create({ title: "scope-src" })
            }),
          ),
        ),
      ) as any)
      const diff = [{ file: "scope.txt", patch: "diff", additions: 1, deletions: 0 } as unknown as any]
      yield* (Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dirA)(
            Effect.gen(function* () {
              const s = yield* Storage.Service
              yield* s.write(baseKey(source.id), diff)
              yield* s.write(["session_diff", source.id], diff)
            }),
          ),
        ),
      ) as any)
      const srcSandbox = { enabled: true, mode: "deny" as const, allowedHosts: [], writablePaths: ["/tmp"], version: 0 }
      yield* Effect.promise(() => SandboxStore.write(dirA, source.id as unknown as SessionID, srcSandbox))
      // Seed one user message so transcript copy would be observable if scope were bypassed.
      const seededMsg = yield* (Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dirA)(
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              const { MessageTable: MT } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
              const mid = "msg_scope_seed_01"
              yield* db
                .insert(MT)
                .values({
                  id: mid,
                  session_id: source.id,
                  time_created: Date.now(),
                  time_updated: Date.now(),
                  data: { id: mid, sessionID: source.id, role: "user", time: { created: Date.now(), updated: Date.now() } },
                } as unknown as typeof MT.$inferInsert)
                .run()
                .pipe(Effect.orDie)
              return mid
            }),
          ),
        ),
      ) as any)
      void seededMsg
      const knownTarget = SessionID.descending()
      ForkSeam.nextId = knownTarget as string
      const token = "scope-" + Math.random().toString(36).slice(2, 8)
      const opId = SessionOperation.forkId(source.id, token)
      const req = {
        v: 1 as const,
        requestId: "req-scope-cross",
        opId,
        op: "session/fork" as const,
        idempotencyKey: `fork:${source.id}:${token}`,
        context: { directory: dirB, sessionId: source.id, parentSessionId: null },
        payload: {},
      }
      const res = yield* (Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dirB)(
            Effect.gen(function* () {
              const d = yield* SessionForkDispatchService
              return yield* d.dispatch(req)
            }),
          ),
        ),
      ) as any)
      ForkSeam.nextId = undefined
      expect(res.status).toBe("failed")
      expect(res.failure.code).toBe("scope_mismatch")
      expect(res.accepted).toBe(false)
      // No source path leak in terminal failure.
      expect(JSON.stringify(res)).not.toContain(dirA)
      expect(res.failure.message).not.toContain(dirA)
      // No child session row.
      const children = yield* (Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dirA)(
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              return yield* db.select().from(SessionTable).where(eq(SessionTable.parent_id, source.id)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as any)
      expect((children as any[]).length).toBe(0)
      const targetRow = yield* (Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dirA)(
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              return yield* db.select().from(SessionTable).where(eq(SessionTable.id, knownTarget as never)).get().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as any)
      expect(targetRow).toBeUndefined()
      // No transcript copy for deterministic target.
      const targetMsgs = yield* (Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dirA)(
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              return yield* db.select().from(MessageTable).where(eq(MessageTable.session_id, knownTarget as never)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as any)
      expect((targetMsgs as any[]).length).toBe(0)
      const targetParts = yield* (Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dirA)(
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              return yield* db.select().from(PartTable).where(eq(PartTable.session_id, knownTarget as never)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as any)
      expect((targetParts as any[]).length).toBe(0)
      // No diff/sandbox copy for deterministic target.
      const baseExists = yield* (Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dirB)(
            Effect.gen(function* () {
              const s = yield* Storage.Service
              return yield* s.read<any>(baseKey(knownTarget)).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false)))
            }),
          ),
        ),
      ) as any)
      expect(baseExists).toBe(false)
      const diffExists = yield* (Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dirB)(
            Effect.gen(function* () {
              const s = yield* Storage.Service
              return yield* s.read<any>(["session_diff", knownTarget]).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)), Effect.catchDefect(() => Effect.succeed(false)))
            }),
          ),
        ),
      ) as any)
      expect(diffExists).toBe(false)
      const sandboxCopy = yield* Effect.promise(() => SandboxStore.read(dirB, knownTarget as unknown as SessionID).then((v) => !!v).catch(() => false))
      expect(sandboxCopy).toBe(false)
      // Source preserved.
      const srcRow = yield* (Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dirA)(
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              return yield* db.select().from(SessionTable).where(eq(SessionTable.id, source.id as never)).get().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as any)
      expect(srcRow).toBeDefined()
      // No fork operation row recorded for the rejected cross-directory attempt.
      const opRows = yield* (Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dirA)(
            Effect.gen(function* () {
              const { db } = yield* Database.Service
              const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
              return yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, source.id)).all().pipe(Effect.orDie)
            }),
          ),
        ),
      ) as any)
      expect((opRows as any[]).filter((r) => r.op_kind === "fork").length).toBe(0)
      // Cleanup source artifacts.
      yield* Effect.promise(() => SandboxStore.remove(dirA, source.id as unknown as SessionID).catch(() => undefined as void))
      yield* (Effect.promise(() =>
        AppRuntime.runPromise(
          provideInstance(dirA)(
            Effect.gen(function* () {
              const s = yield* Storage.Service
              yield* s.remove(baseKey(source.id)).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
              yield* s.remove(["session_diff", source.id]).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void))
            }),
          ),
        ),
      ) as any)
    }),
  )

  it.live("symlink alias of the same physical directory forks successfully", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as any)
      const real = fs.realpathSync(tmp.path)
      const alias = `${real}-scope-alias-${Date.now()}`
      yield* Effect.promise(() => fs.promises.symlink(real, alias))
      try {
        const source = yield* (Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(real)(
              Effect.gen(function* () {
                const svc = yield* Session.Service
                return yield* svc.create({ title: "scope-alias-src" })
              }),
            ),
          ),
        ) as any)
        const token = `alias-${Date.now()}`
        const opId = SessionOperation.forkId(source.id, token)
        const req = {
          v: 1 as const,
          requestId: `req-scope-alias-${Date.now()}`,
          opId,
          op: "session/fork" as const,
          idempotencyKey: `fork:${source.id}:${token}`,
          context: { directory: alias, sessionId: source.id, parentSessionId: null },
          payload: {},
        }
        const res = yield* (Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(alias)(
              Effect.gen(function* () {
                const d = yield* SessionForkDispatchService
                return yield* d.dispatch(req)
              }),
            ),
          ),
        ) as any)
        expect(res.status).toBe("succeeded")
        expect(res.data.parentID).toBe(source.id)
        expect(res.data.directory).toBe(real)
      } finally {
        yield* Effect.promise(() => fs.promises.rm(alias, { recursive: true, force: true }).catch(() => undefined))
      }
    }),
  )
})
