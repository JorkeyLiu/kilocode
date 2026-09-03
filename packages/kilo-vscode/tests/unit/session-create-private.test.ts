import { describe, expect, it } from "bun:test"

describe("session/create private peer handle ownership", () => {
  it("requestWithId allocates exact id atomically and concurrent second gets next id", async () => {
    const { PassThrough } = await import("stream")
    const { JsonRpcPeer } = await import("../../src/private-worker/peer")
    const toClient = new PassThrough()
    const toBackend = new PassThrough()
    const backendPeer = new JsonRpcPeer({
      reader: toBackend,
      writer: toClient,
      onRequest: async (method) => {
        if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/create"] }
        if (method === "session/create") {
          await new Promise(() => {})
          return undefined
        }
        throw new Error("unexpected")
      },
    })
    const { ServePrivatePeer } = await import("../../src/services/cli-backend/serve-private-peer")
    const peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 999, epoch: 77, initializeTimeoutMs: 500 })
    try {
      expect(await peer.initialize(500)).toBeTrue()
      const raw = (peer as unknown as { peer: JsonRpcPeer }).peer as JsonRpcPeer
      const h1 = raw.requestWithId("session/create", { v: 1 })
      const h2 = raw.requestWithId("session/create", { v: 1 })
      // prevent unhandled rejection after cancel
      h1.promise.catch(() => {})
      h2.promise.catch(() => {})
      expect(h1.id).not.toBe(h2.id)
      expect(h1.id + 1).toBe(h2.id)
      // cancel first should not affect second
      const cleaned1 = raw.tryCancelPending(h1.id as unknown as number, "test")
      expect(cleaned1).toBeTrue()
      expect(raw.getPendingIds().includes(h1.id)).toBeFalse()
      expect(raw.getPendingIds().includes(h2.id)).toBeTrue()
      const cleaned2 = raw.tryCancelPending(h2.id as unknown as number, "test")
      expect(cleaned2).toBeTrue()
      expect(raw.getPendingCount()).toBe(0)
    } finally {
      try { peer.dispose() } catch {}
      try { backendPeer.dispose() } catch {}
      try { toClient.destroy() } catch {}
      try { toBackend.destroy() } catch {}
    }
  })

  it("privateCreateWithHandle returns exact id and timeout cancel does not affect unrelated pending", async () => {
    const { PassThrough } = await import("stream")
    const { JsonRpcPeer } = await import("../../src/private-worker/peer")
    const { ServePrivatePeer } = await import("../../src/services/cli-backend/serve-private-peer")
    const toClient = new PassThrough()
    const toBackend = new PassThrough()
    const backendPeer = new JsonRpcPeer({
      reader: toBackend,
      writer: toClient,
      onRequest: async (method, params) => {
        if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/create"] }
        if (method === "session/create") {
          await new Promise((r) => setTimeout(r, 3600))
          const req = params as { requestId: string; opId: string; idempotencyKey: string }
          return { v: 1, requestId: req.requestId, opId: req.opId, op: "session/create", idempotencyKey: req.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { session: { id: "ses_new", directory: "/repo", title: "hello" } } }
        }
        if (method === "dummy/concurrentHang") {
          await new Promise(() => {})
          return undefined
        }
        throw new Error("unexpected:" + method)
      },
    })
    const peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 1000, epoch: 78, initializeTimeoutMs: 500 })
    try {
      expect(await peer.initialize(500)).toBeTrue()
      const raw = (peer as unknown as { peer: JsonRpcPeer }).peer as JsonRpcPeer
      // create unrelated concurrent pending before create
      const dummyPromise = raw.request("dummy/concurrentHang", { v: 1 }).catch(() => {})
      await new Promise((r) => setTimeout(r, 30))
      const dummyIds = raw.getPendingIds()
      expect(dummyIds.length).toBe(1)
      const dummyId = dummyIds[0] as number
      const req = { v: 1 as const, requestId: "req1", opId: "create:tok-concurrent", op: "session/create" as const, idempotencyKey: "create:tok-concurrent", context: { directory: "/repo", parentSessionId: null }, payload: {} }
      const handle = peer.privateCreateWithHandle(req as unknown as never)
      handle.promise.catch(() => {})
      expect(handle.id).not.toBe(dummyId)
      expect(raw.getPendingIds().includes(handle.id as unknown as never)).toBeTrue()
      // owned handle cancel must remove only exact pending, dummy remains
      const cleaned = handle.cancel("test exact")
      expect(cleaned).toBeTrue()
      expect(raw.getPendingIds().includes(handle.id as unknown as never)).toBeFalse()
      expect(raw.getPendingIds().includes(dummyId as unknown as never)).toBeTrue()
      // second cancel of same id should be false and trigger fail-closed (peer disposed)
      expect(handle.cancel("again")).toBeFalse()
      expect(peer.isAvailable()).toBeFalse()
      dummyPromise.catch(() => {})
      handle.promise.catch(() => {})
    } finally {
      try { peer.dispose() } catch {}
      try { backendPeer.dispose() } catch {}
      try { toClient.destroy() } catch {}
      try { toBackend.destroy() } catch {}
    }
  })

  it("replacement peer reusing numeric id is not affected by old handle timeout cleanup (owned handle isolation) — create", async () => {
    const { PassThrough } = await import("stream")
    const { JsonRpcPeer } = await import("../../src/private-worker/peer")
    const { ServePrivatePeer } = await import("../../src/services/cli-backend/serve-private-peer")
    const toClientOld = new PassThrough()
    const toBackendOld = new PassThrough()
    const backendOld = new JsonRpcPeer({
      reader: toBackendOld,
      writer: toClientOld,
      onRequest: async (method) => {
        if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/create"] }
        if (method === "session/create") {
          await new Promise(() => {})
          return undefined
        }
        throw new Error("unexpected")
      },
    })
    const peerOld = new ServePrivatePeer({ reader: toClientOld, writer: toBackendOld, pid: 2002, epoch: 80, initializeTimeoutMs: 500 })
    expect(await peerOld.initialize(500)).toBeTrue()
    const toClientNew = new PassThrough()
    const toBackendNew = new PassThrough()
    const backendNew = new JsonRpcPeer({
      reader: toBackendNew,
      writer: toClientNew,
      onRequest: async (method) => {
        if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/create"] }
        if (method === "session/create") {
          await new Promise(() => {})
          return undefined
        }
        throw new Error("unexpected")
      },
    })
    const peerNew = new ServePrivatePeer({ reader: toClientNew, writer: toBackendNew, pid: 2003, epoch: 81, initializeTimeoutMs: 500 })
    expect(await peerNew.initialize(500)).toBeTrue()
    // Mock connection-level handle ownership like KiloConnectionService
    let currentPeer: typeof peerOld | null = peerOld
    let currentEpoch: number | null = 80
    const mockConn = {
      get privatePeer() { return currentPeer },
      get privateEpoch() { return currentEpoch },
      privateCreateWithHandle: (req: unknown) => {
        const peerAtCall = currentPeer!
        const epochAtCall = currentEpoch
        const h = peerAtCall.privateCreateWithHandle(req as never) as { id: number; promise: Promise<unknown>; cancel: (m?: string)=>boolean }
        const origCancel = h.cancel
        const wrappedCancel = (msg = "private parity timeout") => {
          const isCurrent = currentPeer === peerAtCall && currentEpoch === epochAtCall
          if (!isCurrent) {
            try { peerAtCall.invalidateOnObserverTimeout(`stale observer timeout`) } catch {}
            return false
          }
          return origCancel(msg)
        }
        return { id: h.id, promise: h.promise, cancel: wrappedCancel }
      },
    } as unknown as { privateCreateWithHandle: (r: unknown)=> { id:number; promise:Promise<unknown>; cancel:(m?:string)=>boolean } }
    try {
      const reqOld = { v: 1 as const, requestId: "req-old-create", opId: "create:tok-old", op: "session/create" as const, idempotencyKey: "create:tok-old", context: { directory: "/repo", parentSessionId: null }, payload: {} }
      const handleOld = mockConn.privateCreateWithHandle(reqOld as never)
      handleOld.promise.catch(() => {})
      expect(handleOld.id).toBeGreaterThan(0)
      expect(peerOld.getPendingCount()).toBe(1)
      // replacement
      currentPeer = peerNew
      currentEpoch = 81
      const reqNew = { v: 1 as const, requestId: "req-new-create", opId: "create:tok-new", op: "session/create" as const, idempotencyKey: "create:tok-new", context: { directory: "/repo", parentSessionId: null }, payload: {} }
      const handleNew = mockConn.privateCreateWithHandle(reqNew as never)
      handleNew.promise.catch(() => {})
      expect(handleNew.id).toBe(handleOld.id)
      expect(peerNew.getPendingCount()).toBe(1)
      expect(peerOld.getPendingCount()).toBe(1)
      // old handle cancel must be stale, invalidate old only, leave replacement pending
      const cleanedOld = handleOld.cancel("private parity timeout")
      expect(cleanedOld).toBeFalse()
      expect(peerOld.isDisposed()).toBeTrue()
      expect(peerOld.getPendingCount()).toBe(0)
      expect(peerNew.getPendingCount()).toBe(1)
      expect(peerNew.isAvailable()).toBeTrue()
      const newIds = (peerNew as unknown as { peer: JsonRpcPeer }).peer.getPendingIds()
      expect(newIds.includes(handleNew.id as unknown as never)).toBeTrue()
      // same-peer exact cancel still works
      const cleanedNew = handleNew.cancel("private parity timeout")
      expect(cleanedNew).toBeTrue()
      expect(peerNew.getPendingCount()).toBe(0)
    } finally {
      try { peerOld.dispose() } catch {}
      try { peerNew.dispose() } catch {}
      try { backendOld.dispose() } catch {}
      try { backendNew.dispose() } catch {}
      try { toClientOld.destroy() } catch {}
      try { toBackendOld.destroy() } catch {}
      try { toClientNew.destroy() } catch {}
      try { toBackendNew.destroy() } catch {}
    }
  })
})
