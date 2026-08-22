import { describe, it, expect } from "bun:test"
import { PassThrough } from "stream"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import * as Changefeed from "@opencode-ai/core/retention/changefeed"
import { JsonRpcPeer } from "../../src/private-worker/peer"
import { ErrorCode } from "../../src/private-worker/json-rpc"
import { OBSERVATION_METHODS, OBSERVATION_NOTIFICATION, OBSERVATION_VERSION, type ObservationEntry } from "../../src/private-worker/observation"
import { createChangefeedDeps } from "../../src/private-worker/changefeed-adapter"
import { startWorker } from "../../src/private-worker/worker"

async function withDb<T>(fn: (db: Database.Interface["db"]) => Promise<T>): Promise<T> {
  const layer = Database.layerFromPath(":memory:")
  const prog = Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* Effect.promise(() => fn(db))
  })
  return Effect.runPromise(Effect.provide(prog, layer).pipe(Effect.scoped) as Effect.Effect<T, unknown, never>)
}

function pairFromDeps(deps: ReturnType<typeof createChangefeedDeps>) {
  const aToB = new PassThrough()
  const bToA = new PassThrough()
  const server = startWorker({ reader: aToB, writer: bToA, observationDeps: deps })
  const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
  return { client, server, aToB, bToA }
}

function waitForNotification(received: unknown[], timeoutMs = 1000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const timer = setTimeout(() => reject(new Error("notification timeout")), timeoutMs)
    const check = () => {
      if (received.length > 0) {
        clearTimeout(timer)
        resolve(received[0])
        return
      }
      if (Date.now() - start > timeoutMs) {
        clearTimeout(timer)
        reject(new Error("notification timeout"))
        return
      }
      setTimeout(check, 5)
    }
    check()
  })
}

describe("observation changefeed adapter + worker routing (real storage) - vscode parity", () => {
  it("routes observation/* through private worker and preserves ping/echo", async () => {
    await withDb(async (db) => {
      const deps = createChangefeedDeps(db)
      const { client, server } = pairFromDeps(deps)
      const pong = (await client.request("ping")) as { pong: boolean }
      expect(pong.pong).toBe(true)
      const echo = (await client.request("echo", { x: 2 })) as { x: number }
      expect(echo.x).toBe(2)
      const snap = (await client.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { v: string; cursor: number }
      expect(snap.v).toBe(OBSERVATION_VERSION)
      expect(snap.cursor).toBe(0)
      client.dispose()
      server.dispose()
    })
  })

  it("snapshot/read/ack backed by canonical changefeed storage", async () => {
    await withDb(async (db) => {
      const e1 = await Effect.runPromise(Changefeed.append(db, { session_id: "ses_a", revision: 1, kind: "changed", time: 100 }))
      const e2 = await Effect.runPromise(Changefeed.append(db, { session_id: "ses_b", revision: 1, kind: "changed", time: 101 }))
      const deps = createChangefeedDeps(db)
      const { client, server } = pairFromDeps(deps)
      const snap = (await client.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number; v: string }
      expect(snap.cursor).toBe(e2.seq)
      const r0 = (await client.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { entries: ObservationEntry[]; rehydrate: boolean; cursor: number }
      expect(r0.rehydrate).toBe(false)
      expect(r0.entries.length).toBe(2)
      expect(r0.entries.map((e) => e.seq)).toEqual([e1.seq, e2.seq])
      expect(Object.keys(r0.entries[0]!).sort()).toEqual(["kind", "revision", "seq", "session_id", "time"])
      await client.request(OBSERVATION_METHODS.ACK, { cursor: e1.seq })
      const afterAck = (await client.request(OBSERVATION_METHODS.READ, { cursor: e1.seq })) as { rehydrate: boolean; entries: ObservationEntry[] }
      expect(afterAck.rehydrate).toBe(false)
      expect(afterAck.entries.length).toBe(1)
      const gap = (await client.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { rehydrate: boolean }
      expect(gap.rehydrate).toBe(true)
      client.dispose()
      server.dispose()
    })
  })

  it("ack ahead maps to InvalidParams", async () => {
    await withDb(async (db) => {
      const e1 = await Effect.runPromise(Changefeed.append(db, { session_id: "ses_ack", revision: 1, kind: "changed", time: 1 }))
      const deps = createChangefeedDeps(db)
      const { client, server } = pairFromDeps(deps)
      try {
        await client.request(OBSERVATION_METHODS.ACK, { cursor: e1.seq + 100 })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      const st = await Effect.runPromise(Changefeed.getState(db))
      expect(st.latest_seq).toBe(e1.seq)
      client.dispose()
      server.dispose()
    })
  })

  it("observation/subscribe against real changefeed returns versioned envelope", async () => {
    await withDb(async (db) => {
      const e1 = await Effect.runPromise(Changefeed.append(db, { session_id: "ses_sub", revision: 1, kind: "changed", time: 10 }))
      await Effect.runPromise(Changefeed.append(db, { session_id: "ses_sub2", revision: 1, kind: "changed", time: 11 }))
      const deps = createChangefeedDeps(db)
      const { client, server } = pairFromDeps(deps)
      const snap = (await client.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number; v: string }
      expect(snap.v).toBe(OBSERVATION_VERSION)
      expect(snap.cursor).toBe(e1.seq + 1)
      const sub = (await client.request(OBSERVATION_METHODS.SUBSCRIBE, {})) as { v: string; cursor: number; subscribed: boolean }
      expect(sub.v).toBe(OBSERVATION_VERSION)
      expect(sub.subscribed).toBe(true)
      expect(sub.cursor).toBe(snap.cursor)
      const subWithCursor = (await client.request(OBSERVATION_METHODS.SUBSCRIBE, { cursor: 0 })) as { v: string; cursor: number; subscribed: boolean }
      expect(subWithCursor.v).toBe(OBSERVATION_VERSION)
      expect(subWithCursor.subscribed).toBe(true)
      expect(subWithCursor.cursor).toBe(snap.cursor)
      try {
        await client.request(OBSERVATION_METHODS.SUBSCRIBE, { cursor: "bad" as unknown as number })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      client.dispose()
      server.dispose()
    })
  })

  it("observation/read with cursor ahead of latest returns explicit rehydrate", async () => {
    await withDb(async (db) => {
      const e1 = await Effect.runPromise(Changefeed.append(db, { session_id: "ses_ahead", revision: 1, kind: "changed", time: 1 }))
      const deps = createChangefeedDeps(db)
      const { client, server } = pairFromDeps(deps)
      const snap = (await client.request(OBSERVATION_METHODS.SNAPSHOT, {})) as { cursor: number; v: string }
      expect(snap.cursor).toBe(e1.seq)
      const ahead = snap.cursor + 10
      const res = (await client.request(OBSERVATION_METHODS.READ, { cursor: ahead })) as { rehydrate: boolean; cursor: number; reason: string; entries: ObservationEntry[]; v: string }
      expect(res.rehydrate).toBe(true)
      expect(res.cursor).toBe(snap.cursor)
      expect(res.v).toBe(OBSERVATION_VERSION)
      expect(res.entries.length).toBe(0)
      expect(typeof res.reason).toBe("string")
      expect(res.reason).toMatch(/ahead/i)
      client.dispose()
      server.dispose()
    })
  })

  it("deleted kind and versioned notification", async () => {
    await withDb(async (db) => {
      const eDel = await Effect.runPromise(Changefeed.append(db, { session_id: "ses_del", revision: 1, kind: "deleted", time: 999 }))
      const deps = createChangefeedDeps(db)
      const aToB = new PassThrough()
      const bToA = new PassThrough()
      const server = startWorker({ reader: aToB, writer: bToA, observationDeps: deps })
      const received: unknown[] = []
      const client = new JsonRpcPeer({ reader: bToA, writer: aToB, onNotification: (m, p) => received.push({ m, p }) })
      try {
        const read = (await client.request(OBSERVATION_METHODS.READ, { cursor: 0 })) as { entries: ObservationEntry[] }
        expect(read.entries[0]!.kind).toBe("deleted")
        const { ObservationController } = await import("../../src/private-worker/observation")
        const ctrl = new ObservationController(deps)
        ctrl.notifyChanged(server, [eDel as ObservationEntry], eDel.seq)
        await waitForNotification(received, 1000)
        expect(received.length).toBe(1)
        const notif = received[0] as { m: string; p: { v: string; cursor: number } }
        expect(notif.m).toBe(OBSERVATION_NOTIFICATION)
        expect(notif.p.v).toBe(OBSERVATION_VERSION)
      } finally {
        client.dispose()
        server.dispose()
      }
    })
  })

  it("host forwards observation/changed notifications", async () => {
    await withDb(async (db) => {
      await Effect.runPromise(Changefeed.append(db, { session_id: "ses_host", revision: 1, kind: "changed", time: 1 }))
      const deps = createChangefeedDeps(db)
      // Simulate worker and host peers directly (unit, no child process)
      const aToB = new PassThrough()
      const bToA = new PassThrough()
      const server = startWorker({ reader: aToB, writer: bToA, observationDeps: deps })
      const received: unknown[] = []
      const hostClient = new JsonRpcPeer({ reader: bToA, writer: aToB, onNotification: (m, p) => received.push({ m, p }) })
      try {
        // worker pushes notification
        const e = await Effect.runPromise(Changefeed.append(db, { session_id: "ses_host2", revision: 1, kind: "changed", time: 2 }))
        const { ObservationController } = await import("../../src/private-worker/observation")
        const ctrl = new ObservationController(deps)
        ctrl.notifyChanged(server, [e as ObservationEntry], e.seq)
        await waitForNotification(received, 1000)
        expect(received.length).toBe(1)
        const notif = received[0] as { m: string; p: unknown }
        expect(notif.m).toBe(OBSERVATION_NOTIFICATION)
      } finally {
        hostClient.dispose()
        server.dispose()
      }
    })
  })

  it("unknown method returns MethodNotFound and preserves error codes", async () => {
    await withDb(async (db) => {
      const deps = createChangefeedDeps(db)
      const aToB = new PassThrough()
      const bToA = new PassThrough()
      const server = startWorker({ reader: aToB, writer: bToA, observationDeps: deps })
      const client = new JsonRpcPeer({ reader: bToA, writer: aToB })
      try {
        await client.request("observation/unknown", {})
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.MethodNotFound)
      }
      try {
        await client.request(OBSERVATION_METHODS.READ, { cursor: "bad" as unknown as number })
        expect(false).toBe(true)
      } catch (e) {
        expect((e as { code?: number }).code).toBe(ErrorCode.InvalidParams)
      }
      client.dispose()
      server.dispose()
    })
  })
})
