// @ts-nocheck
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
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
import { Server } from "../../../src/server/server"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

const it = testEffect(Layer.empty)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("sessionFork B3", () => {
  it.live("success creates forked session and operation with snapshot", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source" }) })))) as unknown as Effect.Effect<any, any, any>)
      const token = "tok-" + Math.random().toString(36).slice(2, 8)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-fork-1", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(res.status).toBe("succeeded")
      expect(res.data.id).toBeDefined()
      expect(res.data.parentID).toBe(source.id)
      expect(res.data.directory).toBe(dir)
      expect(res.data.title).toContain("fork #1")
      // source still exists
      const src = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.get(SessionID.make(source.id)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(src.id).toBe(source.id)
      // forked session exists via get
      const forked = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.get(SessionID.make(res.data.id)) })))) as unknown as Effect.Effect<any, any, any>)
      expect(forked.id).toBe(res.data.id)
      // operation row exists
      const opRows = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); return yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, source.id)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect((opRows as any[]).filter((r) => r.op_kind === "fork").length).toBe(1)
      expect((opRows as any[]).find((r) => r.op_id === opId).result_snapshot).toBeDefined()
    }),
  )

  it.live("same-key replay returns same forked session without duplicate", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source" }) })))) as unknown as Effect.Effect<any, any, any>)
      const token = "replay-" + Math.random().toString(36).slice(2, 8)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-replay", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r1.status).toBe("succeeded")
      const forkedId = r1.data.id
      const r2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r2.status).toBe("succeeded")
      expect(r2.data.id).toBe(forkedId)
      // count sessions: source + 1 fork
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).filter((s) => s.parentID === source.id).length).toBe(1)
      const opRows = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const db = (yield* Database.Service).db; const { SessionOperationTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql")); return yield* db.select().from(SessionOperationTable).where(eq(SessionOperationTable.session_id, source.id)).all().pipe(Effect.orDie) })))) as unknown as Effect.Effect<any, any, any>)
      expect((opRows as any[]).filter((r) => r.op_kind === "fork").length).toBe(1)
    }),
  )

  it.live("conflict on same key different target directory fails", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const other = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const otherDir = other.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source" }) })))) as unknown as Effect.Effect<any, any, any>)
      const token = "conflict-" + Math.random().toString(36).slice(2, 8)
      const opId = SessionOperation.forkId(source.id, token)
      const req1 = { v: 1 as const, requestId: "req-c1", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req1) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r1.status).toBe("succeeded")
      const req2 = { v: 1 as const, requestId: "req-c2", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: otherDir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const r2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req2) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r2.status).toBe("failed")
      expect(r2.failure.code).toBe("conflict")
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).filter((s) => s.parentID === source.id).length).toBe(1)
    }),
  )

  it.live("opId with different idempotencyKey fails validation (canonical identity)", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source" }) })))) as unknown as Effect.Effect<any, any, any>)
      const token = "collide-" + Math.random().toString(36).slice(2, 8)
      const token2 = "collide2-" + Math.random().toString(36).slice(2, 8)
      const opId = SessionOperation.forkId(source.id, token)
      const req1 = { v: 1 as const, requestId: "req-o1", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const r1 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req1) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r1.status).toBe("succeeded")
      const req2 = { v: 1 as const, requestId: "req-o2", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token2}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const r2 = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req2) })))) as unknown as Effect.Effect<any, any, any>)
      expect(r2.status).toBe("failed")
      expect(r2.failure.code).toBe("validation.failed")
    }),
  )

  it.live("validation fails without mutation for bad directory and missing fields", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source" }) })))) as unknown as Effect.Effect<any, any, any>)
      const token = "val-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.forkId(source.id, token)
      const badReqs: unknown[] = [
        { v: 1, requestId: "", opId, op: "session/fork", idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} },
        { v: 1, requestId: "req-bad2", opId, op: "session/fork", idempotencyKey: `fork:${source.id}:${token}`, context: { directory: "relative/path", sessionId: source.id, parentSessionId: null }, payload: {} },
        { v: 1, requestId: "req-bad3", opId, op: "session/fork", idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: "ses_other" }, payload: {}, extra: "field" },
      ]
      for (const bad of badReqs) {
        const res = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(bad) })))) as unknown as Effect.Effect<any, any, any>)
        expect(res.status).toBe("failed")
        expect(res.failure.code).toBe("validation.failed")
      }
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).filter((s) => s.parentID === source.id).length).toBe(0)
    }),
  )

  it.live("private dispatch does not mutate when no record", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source" }) })))) as unknown as Effect.Effect<any, any, any>)
      const token = "priv-no-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-priv-no", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const priv = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* (d as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(priv.status).toBe("failed")
      expect(priv.failure.code).toBe("internal")
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).filter((s) => s.parentID === source.id).length).toBe(0)
    }),
  )

  it.live("private replay returns same persisted fork without second session", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source" }) })))) as unknown as Effect.Effect<any, any, any>)
      const token = "priv-replay-" + Math.random().toString(36).slice(2, 8)
      const opId = SessionOperation.forkId(source.id, token)
      const req = { v: 1 as const, requestId: "req-priv-replay", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${token}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const sdkRes = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(sdkRes.status).toBe("succeeded")
      const privRes = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* (d as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate(req) })))) as unknown as Effect.Effect<any, any, any>)
      expect(privRes.status).toBe("succeeded")
      const privId = (privRes.data as { id?: string; session?: { id: string } }).session?.id ?? (privRes.data as { id?: string }).id
      expect(privId).toBe(sdkRes.data.id)
      const list = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.list({}) })))) as unknown as Effect.Effect<any, any, any>)
      expect((list as any[]).filter((s) => s.parentID === source.id).length).toBe(1)
    }),
  )

  it.live("HTTP durable fork via Server.listen succeeds and is replay-safe", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const listener = yield* Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 }))
      try {
        const createUrl = new URL(`/session?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const createRes = yield* Effect.promise(() => fetch(createUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "source-http" }) }))
        expect(createRes.status).toBe(200)
        const source = yield* Effect.promise(() => createRes.json() as Promise<{ id: string }>)
        const token = "http-" + Math.random().toString(36).slice(2, 8)
        const opId = SessionOperation.forkId(source.id, token)
        const body = { idempotencyKey: `fork:${source.id}:${token}`, requestId: "req-http-fork", opId, context: { directory: dir, sessionId: source.id, parentSessionId: null } }
        const forkUrl = new URL(`/session/${source.id}/fork?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const res1 = yield* Effect.promise(() => fetch(forkUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))
        expect(res1.status).toBe(200)
        const data1 = yield* Effect.promise(() => res1.json() as Promise<{ id: string }>)
        expect(data1.id).toBeDefined()
        const res2 = yield* Effect.promise(() => fetch(forkUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }))
        expect(res2.status).toBe(200)
        const data2 = yield* Effect.promise(() => res2.json() as Promise<{ id: string }>)
        expect(data2.id).toBe(data1.id)
        const listUrl = new URL(`/session?directory=${encodeURIComponent(dir)}`, listener.url).toString()
        const listRes = yield* Effect.promise(() => fetch(listUrl))
        const list = yield* Effect.promise(() => listRes.json() as Promise<{ id: string; parentID?: string }[]>)
        expect((list as unknown as any[]).filter((s: any) => s.parentID === source.id).length).toBe(1)
      } finally {
        yield* Effect.promise(() => listener.stop())
      }
    }),
  )

  it.live("fork rejects mismatched idempotencyKey and colon in token", () =>
    Effect.gen(function* () {
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "source" }) })))) as unknown as Effect.Effect<any, any, any>)
      const token = "ok-" + Math.random().toString(36).slice(2, 6)
      const opId = SessionOperation.forkId(source.id, token)
      const reqMismatch = { v: 1 as const, requestId: "req-m", opId, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:different`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const rMismatch = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(reqMismatch) })))) as unknown as Effect.Effect<any, any, any>)
      expect(rMismatch.status).toBe("failed")
      expect((rMismatch as any).failure.code).toBe("validation.failed")
      const opIdColon = `fork:${source.id}:bad:token`
      const reqColon = { v: 1 as const, requestId: "req-c", opId: opIdColon, op: "session/fork" as const, idempotencyKey: opIdColon, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const rColon = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(reqColon) })))) as unknown as Effect.Effect<any, any, any>)
      expect(rColon.status).toBe("failed")
      expect((rColon as any).failure.code).toBe("validation.failed")
      const rPrivMismatch = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* (d as unknown as { dispatchPrivate: (r: unknown) => Effect.Effect<unknown> }).dispatchPrivate(reqMismatch) })))) as unknown as Effect.Effect<any, any, any>)
      expect(rPrivMismatch.status).toBe("failed")
      expect((rPrivMismatch as any).failure.code).toBe("validation.failed")
      const appLayer = yield* Effect.promise(() => import("../../../src/effect/app-runtime").then((m) => (m as any).makeAppLayer())) as unknown as Effect.Effect<any, any, any>
      const server = yield* Effect.promise(() => (import("../../../src/server/server") as any).then((m: any) => m.Server.listen({ hostname: "127.0.0.1", port: 0, appLayer }))) as unknown as Effect.Effect<any, any, any>
      try {
        const url = new URL(`/session/${source.id}/fork?directory=${encodeURIComponent(dir)}`, (server as any).url).toString()
        const res = yield* Effect.promise(() => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey: `fork:${source.id}:different`, requestId: "req-http-m", opId, context: { directory: dir, sessionId: source.id, parentSessionId: null } }) }))
        expect(res.status).toBe(400)
      } finally {
        yield* Effect.promise(() => (server as any).stop())
      }
    }),
  )

  it.live("fd-carrier session/fork is replay-only and positive replay works", () =>
    Effect.gen(function* () {
      const { createFdCarrier } = yield* Effect.promise(() => import("../../../src/kilocode/server/fd-carrier"))
      const { JsonRpcPeer } = yield* Effect.promise(() => import("../../../src/private-worker/peer"))
      const { PassThrough } = yield* Effect.promise(() => import("stream"))
      // need env for carrier
      const prev = process.env.KILO_PARENT_PID
      process.env.KILO_PARENT_PID = String(process.pid)
      const tmp = yield* (Effect.promise(() => tmpdir({ git: true, retain: true })) as unknown as Effect.Effect<any, any, any>)
      const dir = tmp.path
      const source = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const svc = yield* Session.Service; return yield* svc.create({ title: "carrier-fork" }) })))) as unknown as Effect.Effect<any, any, any>)
      const tokenNo = "no-record-" + Math.random().toString(36).slice(2, 6)
      const opIdNo = SessionOperation.forkId(source.id, tokenNo)
      const reqNo = { v: 1 as const, requestId: "req-no", opId: opIdNo, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${tokenNo}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
      const extToCarrier = new (PassThrough as unknown as new () => any)()
      const carrierToExt = new (PassThrough as unknown as new () => any)()
      const carrier = createFdCarrier(extToCarrier, carrierToExt)
      const ext = new JsonRpcPeer({ reader: carrierToExt, writer: extToCarrier })
      try {
        yield* Effect.promise(() => ext.request("initialize", { protocol: { name: "kilo-private", major: 1, minor: 0 }, clientInfo: { name: "kilo-vscode", version: "7.4.11" }, capabilities: ["session/fork", "session/update", "session/cancelQueued"] }))
        const noRes = (yield* Effect.promise(() => ext.request("session/fork", reqNo) as Promise<Record<string, unknown>>)) as Record<string, unknown>
        expect(noRes.status).toBe("failed")
        expect((noRes as unknown as { failure: { code: string } }).failure.code).toBe("internal")
        // now create via SDK then replay via carrier
        const tokenYes = "yes-" + Math.random().toString(36).slice(2, 8)
        const opIdYes = SessionOperation.forkId(source.id, tokenYes)
        const reqYes = { v: 1 as const, requestId: "req-yes", opId: opIdYes, op: "session/fork" as const, idempotencyKey: `fork:${source.id}:${tokenYes}`, context: { directory: dir, sessionId: source.id, parentSessionId: null }, payload: {} }
        const sdkRes = yield* (Effect.promise(() => AppRuntime.runPromise(provideInstance(dir)(Effect.gen(function* () { const d = yield* SessionForkDispatchService; return yield* d.dispatch(reqYes) })))) as unknown as Effect.Effect<any, any, any>)
        expect(sdkRes.status).toBe("succeeded")
        const carrierRes = (yield* Effect.promise(() => ext.request("session/fork", reqYes) as Promise<Record<string, unknown>>)) as Record<string, unknown>
        expect(carrierRes.status).toBe("succeeded")
        const cid = ((carrierRes as unknown as { data: { id?: string; session?: { id: string } } }).data.id ?? (carrierRes as unknown as { data: { session: { id: string } } }).data.session?.id)
        expect(cid).toBe(sdkRes.data.id)
      } finally {
        try { carrier.dispose() } catch {}
        try { ext.dispose() } catch {}
        if (prev !== undefined) process.env.KILO_PARENT_PID = prev; else delete process.env.KILO_PARENT_PID
      }
    }),
  )
})
