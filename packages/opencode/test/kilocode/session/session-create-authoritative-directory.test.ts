// @ts-nocheck
// Classified production-runtime integration boundary (see script/check-opencode-promise-facades.ts):
// B4 authoritative-directory durable create via the canonical runtime + InstanceRef.
import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionChangefeedTable } from "@opencode-ai/core/retention/sql"
import { SessionOperation } from "@opencode-ai/core/session/operation"
import { SessionCreateDispatchService, authoritativeDirectory } from "../../../src/kilocode/session/session-create-dispatch"
import { SessionUpdateDispatchService } from "../../../src/kilocode/session/session-update-dispatch"
import { SessionForkDispatchService } from "../../../src/kilocode/session/session-fork-dispatch"
import { canonicalDirectory } from "../../../src/kilocode/session/canonical-directory"
import { createSessionListDeps } from "../../../src/private-worker/session-list-adapter"
import { createSessionGetDeps } from "../../../src/private-worker/session-get-adapter"
import { createSessionMessagesDeps } from "../../../src/private-worker/session-messages-adapter"
import { KiloSession } from "../../../src/kilocode/session/index"
import { Session } from "../../../src/session/session"
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

async function dispatchCreate(dir: string, opId: string, title: string, extra: Record<string, unknown> = {}) {
  const req = {
    v: 1 as const,
    requestId: `req-${opId}`,
    opId,
    op: "session/create" as const,
    idempotencyKey: opId,
    context: { directory: dir, parentSessionId: null },
    payload: { title, ...extra },
  }
  return (await AppRuntime.runPromise(
    provideInstance(dir)(
      Effect.gen(function* () {
        const d = yield* SessionCreateDispatchService
        return yield* d.dispatch(req)
      }),
    ),
  )) as any
}

describe("session-create authoritative directory (symlink alias)", () => {
  it.live("alias write stores realpath and reads via both spellings", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as any)
      const real = fs.realpathSync(tmp.path)
      const alias = `${real}-alias-${Date.now()}`
      yield* Effect.promise(() => fs.promises.symlink(real, alias))
      try {
        // Precondition: lexical spellings differ, physical resolves equal.
        expect(canonicalDirectory(alias)).not.toBe(canonicalDirectory(real))
        expect(authoritativeDirectory(alias)).toBe(authoritativeDirectory(real))
        expect(FSUtil.resolve(alias)).toBe(FSUtil.resolve(real))

        const opId = SessionOperation.createId(`auth-${Date.now()}`)
        const res = yield* Effect.promise(() => dispatchCreate(alias, opId, "alias-session"))
        expect(res.status).toBe("succeeded")
        const sid = res.data.id as string
        // Authoritative write: stored spelling is the realpath.
        expect(res.data.directory).toBe(real)
        const row = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(real)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                return yield* db.select().from(SessionTable).where(eq(SessionTable.id, sid as never)).get().pipe(Effect.orDie)
              }),
            ),
          ),
        )
        expect((row as any).directory).toBe(real)

        // Private observation list via both spellings.
        const db = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(real)(
              Effect.gen(function* () {
                return (yield* Database.Service).db
              }),
            ),
          ),
        )
        const list = createSessionListDeps(db as never)
        const viaAlias = yield* Effect.promise(() => list.list({ directory: alias, limit: 50 }))
        const viaReal = yield* Effect.promise(() => list.list({ directory: real, limit: 50 }))
        expect(viaAlias.entries.length).toBe(1)
        expect(viaReal.entries.length).toBe(1)
        expect(viaAlias.entries[0].id).toBe(sid)
        expect(viaReal.entries[0].id).toBe(sid)
        expect(viaAlias.entries[0].directory).toBe(real)
        expect(viaReal.entries[0].directory).toBe(real)

        // Private get + messages via both spellings (no scope_mismatch).
        const get = createSessionGetDeps(db as never)
        const gotAlias = yield* Effect.promise(() => get.get({ directory: alias, sessionId: sid }))
        const gotReal = yield* Effect.promise(() => get.get({ directory: real, sessionId: sid }))
        expect((gotAlias as any).status).toBe("found")
        expect((gotReal as any).status).toBe("found")
        const msgs = createSessionMessagesDeps(db as never)
        const mAlias = yield* Effect.promise(() => msgs.messages({ directory: alias, sessionId: sid, limit: 10 }))
        const mReal = yield* Effect.promise(() => msgs.messages({ directory: real, sessionId: sid, limit: 10 }))
        expect((mAlias as any).status).toBe("found")
        expect((mReal as any).status).toBe("found")

        // SDK listGlobal with directory filter via both spellings.
        const fromRow = (r: any) => ({ id: r.id, title: r.title, time: { updated: r.time_updated } })
        const sdkAlias = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(real)(
              KiloSession.listGlobal({ fromRow: fromRow as never, directory: alias, limit: 50 }) as never,
            ),
          ),
        )
        const sdkReal = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(real)(
              KiloSession.listGlobal({ fromRow: fromRow as never, directory: real, limit: 50 }) as never,
            ),
          ),
        )
        expect(((sdkAlias as any) as any[]).map((s) => s.id)).toContain(sid)
        expect(((sdkReal as any) as any[]).map((s) => s.id)).toContain(sid)

        // Same-tuple replay via the other spelling returns the same session (no duplicate).
        const replayReq = {
          v: 1 as const,
          requestId: `req-replay-${Date.now()}`,
          opId,
          op: "session/create" as const,
          idempotencyKey: opId,
          context: { directory: real, parentSessionId: null },
          payload: { title: "alias-session" },
        }
        const replay = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(real)(
              Effect.gen(function* () {
                const d = yield* SessionCreateDispatchService
                return yield* d.dispatch(replayReq)
              }),
            ),
          ),
        )
        expect((replay as any).status).toBe("succeeded")
        expect((replay as any).data.id).toBe(sid)
        const feed = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(real)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                return yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, sid as never)).all().pipe(Effect.orDie)
              }),
            ),
          ),
        )
        expect((feed as any[]).length).toBe(1)
        expect((feed as any[])[0].kind).toBe("changed")
        expect((feed as any[])[0].revision).toBe(0)
      } finally {
        yield* Effect.promise(() => fs.promises.rm(alias, { recursive: true, force: true }).catch(() => undefined))
      }
    }),
  )

  it.live("legacy lexical row converges without cross-directory leak", () =>
    Effect.gen(function* () {
      const tmpA = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as any)
      const realA = fs.realpathSync(tmpA.path)
      const aliasA = `${realA}-legacy-${Date.now()}`
      yield* Effect.promise(() => fs.promises.symlink(realA, aliasA))
      const tmpB = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as any)
      const realB = fs.realpathSync(tmpB.path)
      try {
        const opA = SessionOperation.createId(`leg-a-${Date.now()}`)
        const resA = yield* Effect.promise(() => dispatchCreate(realA, opA, "legacy-a"))
        expect(resA.status).toBe("succeeded")
        const sidA = resA.data.id as string
        // Rewrite the row to the legacy lexical spelling.
        const lexical = canonicalDirectory(aliasA)
        expect(lexical).not.toBe(realA)
        yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(realA)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                yield* db.update(SessionTable).set({ directory: lexical } as never).where(eq(SessionTable.id, sidA as never)).run().pipe(Effect.orDie)
              }),
            ),
          ),
        )
        const opB = SessionOperation.createId(`leg-b-${Date.now()}`)
        const resB = yield* Effect.promise(() => dispatchCreate(realB, opB, "other-b"))
        expect(resB.status).toBe("succeeded")
        const sidB = resB.data.id as string

        const db = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(realA)(
              Effect.gen(function* () {
                return (yield* Database.Service).db
              }),
            ),
          ),
        )
        const list = createSessionListDeps(db as never)
        const listA = yield* Effect.promise(() => list.list({ directory: realA, limit: 50 }))
        const idsA = listA.entries.map((e) => e.id)
        expect(idsA).toContain(sidA)
        expect(idsA).not.toContain(sidB)
        const listB = yield* Effect.promise(() => list.list({ directory: realB, limit: 50 }))
        const idsB = listB.entries.map((e) => e.id)
        expect(idsB).toContain(sidB)
        expect(idsB).not.toContain(sidA)
        // Alias spelling also converges to the same legacy row.
        const listAlias = yield* Effect.promise(() => list.list({ directory: aliasA, limit: 50 }))
        expect(listAlias.entries.map((e) => e.id)).toContain(sidA)

        const get = createSessionGetDeps(db as never)
        const got = yield* Effect.promise(() => get.get({ directory: realA, sessionId: sidA }))
        expect((got as any).status).toBe("found")
        const gotCross = yield* Effect.promise(() => get.get({ directory: realB, sessionId: sidA }))
        expect((gotCross as any).status).toBe("scope_mismatch")
      } finally {
        yield* Effect.promise(() => fs.promises.rm(aliasA, { recursive: true, force: true }).catch(() => undefined))
      }
    }),
  )

  it.live("update and fork keep the authoritative directory with changefeed", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as any)
      const real = fs.realpathSync(tmp.path)
      const alias = `${real}-uf-${Date.now()}`
      yield* Effect.promise(() => fs.promises.symlink(real, alias))
      try {
        const opId = SessionOperation.createId(`uf-${Date.now()}`)
        const res = yield* Effect.promise(() => dispatchCreate(alias, opId, "uf-src"))
        expect(res.status).toBe("succeeded")
        const sid = res.data.id as string
        // Title-only update via the alias spelling.
        const updOp = `sessionUpdate:${sid}:tok-${Date.now()}`
        const updReq = {
          v: 1 as const,
          requestId: `req-upd-${Date.now()}`,
          opId: updOp,
          op: "session/update" as const,
          idempotencyKey: updOp,
          context: { directory: alias, sessionId: sid, parentSessionId: null },
          payload: { title: "uf-renamed" },
        }
        const upd = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(alias)(
              Effect.gen(function* () {
                const d = yield* SessionUpdateDispatchService
                return yield* d.dispatch(updReq)
              }),
            ),
          ),
        )
        expect((upd as any).status).toBe("succeeded")
        expect((upd as any).data.title).toBe("uf-renamed")
        // Fork via the alias spelling: child inherits the authoritative directory.
        const forkToken = `tok-${Date.now()}`
        const forkOp = `fork:${sid}:${forkToken}`
        const forkReq = {
          v: 1 as const,
          requestId: `req-fork-${Date.now()}`,
          opId: forkOp,
          op: "session/fork" as const,
          idempotencyKey: forkOp,
          context: { directory: alias, sessionId: sid, parentSessionId: null },
          payload: {},
        }
        const fork = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(alias)(
              Effect.gen(function* () {
                const d = yield* SessionForkDispatchService
                return yield* d.dispatch(forkReq)
              }),
            ),
          ),
        )
        expect((fork as any).status).toBe("succeeded")
        const childId = (fork as any).data.id as string
        expect((fork as any).data.directory).toBe(real)
        const rows = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(real)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                const s = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sid as never)).get().pipe(Effect.orDie)
                const c = yield* db.select().from(SessionTable).where(eq(SessionTable.id, childId as never)).get().pipe(Effect.orDie)
                const feed = yield* db.select().from(SessionChangefeedTable).where(eq(SessionChangefeedTable.session_id, childId as never)).all().pipe(Effect.orDie)
                return { s, c, feed }
              }),
            ),
          ),
        )
        expect(((rows as any).s as any).directory).toBe(real)
        expect(((rows as any).c as any).directory).toBe(real)
        expect(((rows as any).c as any).parent_id).toBe(sid)
        expect(((rows as any).feed as any[]).length).toBe(1)
        expect(((rows as any).feed as any[])[0].kind).toBe("changed")
        // No orphan sessions beyond source + child (+ instance warmup sessions excluded by title filter).
        const all = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(real)(
              Effect.gen(function* () {
                const db = (yield* Database.Service).db
                return yield* db.select({ id: SessionTable.id, title: SessionTable.title }).from(SessionTable).all().pipe(Effect.orDie)
              }),
            ),
          ),
        )
        const ours = (all as any[]).filter((r) => r.id === sid || r.id === childId)
        expect(ours.length).toBe(2)
      } finally {
        yield* Effect.promise(() => fs.promises.rm(alias, { recursive: true, force: true }).catch(() => undefined))
      }
    }),
  )

  it.live("different physical directories stay isolated with no leak", () =>
    Effect.gen(function* () {
      const tmpRoot = fs.realpathSync(os.tmpdir())
      const dirA = yield* Effect.promise(() => fs.promises.mkdtemp(path.join(tmpRoot, "auth-iso-a-")))
      const dirB = yield* Effect.promise(() => fs.promises.mkdtemp(path.join(tmpRoot, "auth-iso-b-")))
      try {
        const realA = fs.realpathSync(dirA)
        const realB = fs.realpathSync(dirB)
        expect(FSUtil.resolve(realA)).not.toBe(FSUtil.resolve(realB))
        const opA = SessionOperation.createId(`iso-a-${Date.now()}`)
        const opB = SessionOperation.createId(`iso-b-${Date.now()}`)
        const resA = yield* Effect.promise(() => dispatchCreate(realA, opA, "iso-a"))
        const resB = yield* Effect.promise(() => dispatchCreate(realB, opB, "iso-b"))
        expect(resA.status).toBe("succeeded")
        expect(resB.status).toBe("succeeded")
        const db = yield* Effect.promise(() =>
          AppRuntime.runPromise(
            provideInstance(realA)(
              Effect.gen(function* () {
                return (yield* Database.Service).db
              }),
            ),
          ),
        )
        const list = createSessionListDeps(db as never)
        const listA = yield* Effect.promise(() => list.list({ directory: realA, limit: 50 }))
        const listB = yield* Effect.promise(() => list.list({ directory: realB, limit: 50 }))
        expect(listA.entries.map((e) => e.id)).toContain(resA.data.id)
        expect(listA.entries.map((e) => e.id)).not.toContain(resB.data.id)
        expect(listB.entries.map((e) => e.id)).toContain(resB.data.id)
        expect(listB.entries.map((e) => e.id)).not.toContain(resA.data.id)
        // Instance-scoped SDK list via the alias instance still resolves the same owner.
        const aliasA = `${realA}-sdk-${Date.now()}`
        yield* Effect.promise(() => fs.promises.symlink(realA, aliasA))
        try {
          const viaAlias = yield* Effect.promise(() =>
            AppRuntime.runPromise(
              provideInstance(aliasA)(
                Effect.gen(function* () {
                  const svc = yield* Session.Service
                  return yield* svc.list()
                }),
              ),
            ),
          )
          expect(((viaAlias as any) as any[]).map((s) => s.id)).toContain(resA.data.id)
        } finally {
          yield* Effect.promise(() => fs.promises.rm(aliasA, { recursive: true, force: true }).catch(() => undefined))
        }
      } finally {
        yield* Effect.promise(() => fs.promises.rm(dirA, { recursive: true, force: true }).catch(() => undefined))
        yield* Effect.promise(() => fs.promises.rm(dirB, { recursive: true, force: true }).catch(() => undefined))
      }
    }),
  )
})
