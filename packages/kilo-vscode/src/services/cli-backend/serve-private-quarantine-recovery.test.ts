import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer, isStaleOwnershipReason } from "./serve-private-peer"
import { KiloConnectionService } from "./connection-service"
import { quarantinePeerOnTimeout } from "./serve-private-quarantine"

function hangingBackend(caps: string[], onMethod?: (method: string) => void): {
  clientReader: PassThrough
  clientWriter: PassThrough
  backendPeer: JsonRpcPeer
  counts: Map<string, number>
} {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const counts = new Map<string, number>()
  const backendPeer = new JsonRpcPeer({
    reader: toBackend,
    writer: toClient,
    onRequest: async (method) => {
      counts.set(method, (counts.get(method) ?? 0) + 1)
      onMethod?.(method)
      if (method === "initialize") {
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: caps }
      }
      return new Promise(() => {})
    },
  })
  return { clientReader: toClient, clientWriter: toBackend, backendPeer, counts }
}

function healthyBackend(caps: string[], counts: Map<string, number>, opts?: { healthMode?: "success" | "failed" | "invalid" | "hang" | "notfound" }): {
  clientReader: PassThrough
  clientWriter: PassThrough
  backendPeer: JsonRpcPeer
} {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const backendPeer = new JsonRpcPeer({
    reader: toBackend,
    writer: toClient,
    onRequest: async (method, params) => {
      counts.set(method, (counts.get(method) ?? 0) + 1)
      if (method === "initialize") {
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: caps }
      }
      if (method === "transport/health") {
        const mode = opts?.healthMode ?? "success"
        if (mode === "notfound") {
          const err = new Error("Method not found: transport/health") as Error & { code?: number }
          err.code = -32601
          throw err
        }
        if (mode === "hang") return new Promise(() => {})
        if (mode === "failed") {
          const p = params as { requestId: string }
          return { v: 1, requestId: p.requestId, op: "transport/health", status: "failed", outcome: { type: "failed", time: Date.now(), failure: { code: "internal", message: "internal error", retryable: false } }, accepted: false, failure: { code: "internal", message: "internal error", retryable: false } }
        }
        if (mode === "invalid") return { bogus: true }
        const p = params as { requestId: string }
        return { v: 1, requestId: p.requestId, op: "transport/health", status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { ok: true } }
      }
      if (method === "mcp/status") {
        const p = params as { requestId: string; opId: string; idempotencyKey: string }
        return { v: 1, requestId: p.requestId, opId: p.opId, op: "mcp/status", idempotencyKey: p.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { status: {} } }
      }
      if (method === "kilo/auth-status") {
        const p = params as { requestId: string }
        return { v: 1, requestId: p.requestId, op: "kilo/auth-status", status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { authenticated: false } }
      }
      if (method === "find/files") {
        const p = params as { requestId: string; opId: string; idempotencyKey: string }
        return { v: 1, requestId: p.requestId, opId: p.opId, op: "find/files", idempotencyKey: p.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { files: [] } }
      }
      return new Promise(() => {})
    },
  })
  return { clientReader: toClient, clientWriter: toBackend, backendPeer }
}

function cleanup(peer: { dispose: () => void }, backend: { dispose: () => void }, ...streams: Array<{ destroy?: () => void }>) {
  for (const p of [peer, backend]) {
    try {
      p.dispose()
    } catch {}
  }
  for (const s of streams) {
    try {
      s.destroy?.()
    } catch {}
  }
}

describe("quarantine preserves peer and monotonic ids", () => {
  test("cancel miss quarantines without dispose, ids monotonic, late ignored", async () => {
    const { clientReader, clientWriter, backendPeer } = hangingBackend(["session/update", "mcp/status", "transport/health"])
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 1, epoch: 11, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    expect(peer.isAvailable()).toBeTrue()
    const before = peer.peekNextJsonRpcId()!
    const req = { v: 1 as const, requestId: "r1", opId: "sessionUpdate:ses_a:t1", op: "session/update" as const, idempotencyKey: "sessionUpdate:ses_a:t1", context: { directory: "/tmp", sessionId: "ses_a", parentSessionId: null }, payload: { title: "t" } }
    const handle = peer.privateSessionUpdateWithHandle(req)
    expect(peer.getPendingCount()).toBe(1)
    expect(handle.cancel("private parity timeout")).toBeTrue()
    const res = await handle.promise
    expect(res.status).toBe("ambiguous")
    // second miss quarantines (not disposes)
    expect(handle.cancel("private parity timeout")).toBeFalse()
    expect(peer.isAvailable()).toBeFalse()
    expect(peer.isQuarantined()).toBeTrue()
    expect(peer.isDisposed()).toBeFalse()
    expect(peer.getLifecycleState()).toBe("quarantined")
    const afterMiss = peer.peekNextJsonRpcId()!
    expect(afterMiss).toBeGreaterThan(before)
    // ordinary outbound fails without allocating ids
    const peekBefore = peer.peekNextJsonRpcId()!
    try {
      peer.privateMcpStatusOutcomeWithHandle({ v: 1, requestId: "x", opId: "mcp-status:t", op: "mcp/status", idempotencyKey: "mcp-status:t", context: { directory: "/tmp" }, payload: {} } as never)
      expect.unreachable()
    } catch (e) {
      expect(String((e as Error).message)).toMatch(/unavailable/i)
    }
    expect(peer.peekNextJsonRpcId()).toBe(peekBefore)
    cleanup(peer, backendPeer, clientReader, clientWriter)
  })

  test("health success restores available; invalid/notfound/timeout keep quarantine", async () => {
    const counts = new Map<string, number>()
    const { clientReader, clientWriter, backendPeer } = healthyBackend(["session/cancelQueued", "mcp/status", "transport/health", "kilo/auth-status", "find/files"], counts, { healthMode: "success" })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 2, epoch: 12, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    peer.enterQuarantine("test miss")
    expect(peer.isQuarantined()).toBeTrue()
    expect(await peer.probeTransportHealth(500)).toBeTrue()
    expect(peer.isAvailable()).toBeTrue()
    expect(peer.isQuarantined()).toBeFalse()
    expect(counts.get("transport/health")).toBe(1)
    cleanup(peer, backendPeer, clientReader, clientWriter)
  })

  test("health invalid keeps quarantine", async () => {
    const counts = new Map<string, number>()
    const { clientReader, clientWriter, backendPeer } = healthyBackend(["session/cancelQueued", "mcp/status", "transport/health", "kilo/auth-status", "find/files"], counts, { healthMode: "invalid" })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 3, epoch: 13, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    peer.enterQuarantine("test miss")
    expect(await peer.probeTransportHealth(500)).toBeFalse()
    expect(peer.isQuarantined()).toBeTrue()
    expect(peer.isAvailable()).toBeFalse()
    cleanup(peer, backendPeer, clientReader, clientWriter)
  })

  test("health MethodNotFound keeps quarantine", async () => {
    const counts = new Map<string, number>()
    const { clientReader, clientWriter, backendPeer } = healthyBackend(["session/cancelQueued", "mcp/status", "transport/health", "kilo/auth-status", "find/files"], counts, { healthMode: "notfound" })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 4, epoch: 14, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    peer.enterQuarantine("test miss")
    expect(await peer.probeTransportHealth(500)).toBeFalse()
    expect(peer.isQuarantined()).toBeTrue()
    cleanup(peer, backendPeer, clientReader, clientWriter)
  })

  test("health timeout keeps quarantine without recurse; real close disposes", async () => {
    const counts = new Map<string, number>()
    const { clientReader, clientWriter, backendPeer } = healthyBackend(["session/cancelQueued", "mcp/status", "transport/health", "kilo/auth-status", "find/files"], counts, { healthMode: "hang" })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 5, epoch: 15, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    peer.enterQuarantine("test miss")
    expect(await peer.probeTransportHealth(80)).toBeFalse()
    expect(peer.isQuarantined()).toBeTrue()
    expect(peer.isDisposed()).toBeFalse()
    // real close still destroys ownership via stream teardown
    try {
      ;(clientReader as PassThrough).destroy()
    } catch {}
    try {
      ;(clientWriter as PassThrough).destroy()
    } catch {}
    await new Promise((r) => setTimeout(r, 50))
    expect(peer.isAvailable()).toBeFalse()
    expect(peer.isQuarantined()).toBeFalse()
    expect(peer.getLifecycleState()).toBe("closed")
    cleanup(peer, backendPeer, clientReader, clientWriter)
  })
})

describe("reverse fail-closed while quarantined", () => {
  test("new reverse rejected before secret/fetch and active aborted", async () => {
    // Active incoming abort at JsonRpcPeer level preserves open transport
    const aToB = new PassThrough()
    const bToA = new PassThrough()
    let signalSeen: AbortSignal | null = null
    const extPeer = new JsonRpcPeer({
      reader: bToA,
      writer: aToB,
      onRequest: async (_m, _p, ctx) => {
        signalSeen = ctx.signal
        return new Promise((_res, rej) => {
          const t = setTimeout(() => {}, 5000)
          ;(t as unknown as { unref?: () => void }).unref?.()
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(t)
            const err = new Error("aborted") as Error & { code?: number }
            err.code = -32603
            rej(err)
          })
        })
      },
    })
    const backendPeer = new JsonRpcPeer({ reader: aToB, writer: bToA })
    const pending = backendPeer.request("provider/httpExecute", { providerId: "p", modelId: "m" })
    void pending.catch(() => {})
    await new Promise((r) => setTimeout(r, 30))
    expect(extPeer.getIncomingCount()).toBe(1)
    const aborted = extPeer.abortIncomingForQuarantine()
    expect(aborted).toBe(1)
    expect(extPeer.getIncomingCount()).toBe(0)
    expect(extPeer.getState()).toBe("open")
    expect(signalSeen?.aborted).toBeTrue()
    cleanup(extPeer, backendPeer, aToB, bToA)

    // ServePrivatePeer quarantine rejects new reverse before secret
    let secretCalls = 0
    const { clientReader, clientWriter, backendPeer: b2 } = hangingBackend(["session/cancelQueued", "mcp/status", "transport/health", "kilo/auth-status", "find/files"])
    const peer = new ServePrivatePeer({
      reader: clientReader,
      writer: clientWriter,
      pid: 6,
      epoch: 16,
      initializeTimeoutMs: 300,
      providerHttpExecuteDeps: { resolveSecret: async () => { secretCalls += 1; return "s" } },
    })
    expect(await peer.initialize(300)).toBeTrue()
    peer.enterQuarantine("test")
    // backend sends reverse; extension must reject with MethodNotFound without secret
    const rev = (b2 as JsonRpcPeer).request("provider/httpExecute", { providerId: "p", modelId: "m", record: {}, body: "{}" })
    let code: number | undefined
    try {
      await rev
    } catch (e) {
      code = (e as { code?: number }).code
    }
    expect(code).toBe(-32601)
    expect(secretCalls).toBe(0)
    cleanup(peer, b2, clientReader, clientWriter)
  })
})

describe("single-flight lazy recovery and listeners", () => {
  test("concurrent recoveries share one health probe and each performs own op", async () => {
    const counts = new Map<string, number>()
    const { clientReader, clientWriter, backendPeer } = healthyBackend(["session/cancelQueued", "mcp/status", "transport/health", "kilo/auth-status", "find/files"], counts, { healthMode: "success" })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 7, epoch: 17, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    peer.enterQuarantine("miss")
    const results = await Promise.all([peer.ensureRecovered(800), peer.ensureRecovered(800), peer.ensureRecovered(800)])
    expect(results).toEqual([true, true, true])
    expect(counts.get("transport/health")).toBe(1)
    // after success each performs its own one operation
    const mk = (id: string) => ({ v: 1 as const, requestId: id, opId: `mcp-status:${id}`, op: "mcp/status" as const, idempotencyKey: `mcp-status:${id}`, context: { directory: "/tmp" }, payload: {} })
    const h1 = peer.privateMcpStatusOutcomeWithHandle(mk("a") as never)
    const h2 = peer.privateMcpStatusOutcomeWithHandle(mk("b") as never)
    const [o1, o2] = await Promise.all([h1.promise, h2.promise])
    expect(o1.kind).toBe("valid")
    expect(o2.kind).toBe("valid")
    expect(counts.get("mcp/status")).toBe(2)
    cleanup(peer, backendPeer, clientReader, clientWriter)
  })

  test("failed probe performs no ordinary requests", async () => {
    const counts = new Map<string, number>()
    const { clientReader, clientWriter, backendPeer } = healthyBackend(["session/cancelQueued", "mcp/status", "transport/health", "kilo/auth-status", "find/files"], counts, { healthMode: "failed" })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 8, epoch: 18, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    peer.enterQuarantine("miss")
    expect(await peer.ensureRecovered(500)).toBeFalse()
    expect(counts.get("transport/health")).toBe(1)
    expect(counts.get("mcp/status") ?? 0).toBe(0)
    cleanup(peer, backendPeer, clientReader, clientWriter)
  })

  test("stale epoch completion cannot revive replacement", async () => {
    const counts = new Map<string, number>()
    const { clientReader, clientWriter, backendPeer } = healthyBackend(["session/cancelQueued", "mcp/status", "transport/health", "kilo/auth-status", "find/files"], counts, { healthMode: "hang" })
    const oldPeer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 9, epoch: 19, initializeTimeoutMs: 300 })
    expect(await oldPeer.initialize(300)).toBeTrue()
    oldPeer.enterQuarantine("miss")
    const probe = oldPeer.probeTransportHealth(300)
    // replacement: dispose old transport binding is shared, so simulate epoch replacement
    // by disposing old peer (definitive teardown) — late probe must not revive
    oldPeer.dispose()
    expect(await probe).toBeFalse()
    expect(oldPeer.isAvailable()).toBeFalse()
    cleanup(oldPeer, backendPeer, clientReader, clientWriter)
  })

  test("connection listeners fire once on recovery and survive quarantine", async () => {
    const counts = new Map<string, number>()
    const { clientReader, clientWriter, backendPeer } = healthyBackend(["session/cancelQueued", "mcp/status", "transport/health", "kilo/auth-status", "find/files"], counts, { healthMode: "success" })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 10, epoch: 20, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    const svc = new KiloConnectionService({} as never)
    ;(svc as unknown as { privatePeer: unknown }).privatePeer = peer
    ;(svc as unknown as { privateEpoch: unknown }).privateEpoch = 20
    ;(svc as unknown as { privateAvailable: unknown }).privateAvailable = true
    let fires = 0
    svc.onPrivateAvailable(() => {
      fires += 1
    })
    // quarantine preserves listeners (no clear)
    svc.invalidatePrivatePeerOnObserverTimeout("observer timeout exact cancel miss")
    expect(peer.isQuarantined()).toBeTrue()
    expect((svc as unknown as { getPrivatePeer: () => unknown }).getPrivatePeer()).toBe(peer)
    // concurrent recovers share one probe and notify once
    const [a, b] = await Promise.all([svc.ensurePrivateRecovered(800), svc.ensurePrivateRecovered(800)])
    expect(a).toBeTrue()
    expect(b).toBeTrue()
    expect(counts.get("transport/health")).toBe(1)
    expect(fires).toBe(1)
    expect(svc.isPrivateAvailable()).toBeTrue()
    cleanup(peer, backendPeer, clientReader, clientWriter)
    try {
      ;(svc as unknown as { dispose: () => void }).dispose?.()
    } catch {}
  })
})

describe("quarantine audit corrections", () => {
  test("stale predicate matches only genuine ownership reasons", () => {
    expect(isStaleOwnershipReason("stale observer timeout")).toBeTrue()
    expect(isStaleOwnershipReason("stale observer timeout opId=sessionUpdate:ses_a:t1")).toBeTrue()
    expect(isStaleOwnershipReason("stale observer timeout requestId=r1")).toBeTrue()
    expect(isStaleOwnershipReason("children stale observer timeout")).toBeTrue()
    expect(isStaleOwnershipReason("command-list stale private read timeout")).toBeTrue()
    expect(isStaleOwnershipReason("observer timeout exact cancel miss")).toBeFalse()
    expect(isStaleOwnershipReason("observer timeout exact cancel miss opId=sessionUpdate:ses_a:t1")).toBeFalse()
    expect(isStaleOwnershipReason("observer timeout cancel throw opId=foo")).toBeFalse()
  })

  test("opId text containing stale cannot skip quarantine", async () => {
    const { clientReader, clientWriter, backendPeer } = hangingBackend(["session/update", "transport/health"])
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 41, epoch: 51, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    peer.invalidateOnObserverTimeout("observer timeout exact cancel miss opId=sessionUpdate:ses_stale_evil:t1")
    expect(peer.isQuarantined()).toBeTrue()
    cleanup(peer, backendPeer, clientReader, clientWriter)
  })

  test("genuine stale reason skips quarantine", async () => {
    const { clientReader, clientWriter, backendPeer } = hangingBackend(["session/update", "transport/health"])
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 42, epoch: 52, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    peer.invalidateOnObserverTimeout("stale observer timeout opId=sessionUpdate:ses_a:t1")
    expect(peer.isQuarantined()).toBeFalse()
    expect(peer.isAvailable()).toBeTrue()
    cleanup(peer, backendPeer, clientReader, clientWriter)
  })

  test("initialize on quarantined instance returns false without rebinding", async () => {
    const { clientReader, clientWriter, backendPeer } = hangingBackend(["session/update", "transport/health"])
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 43, epoch: 53, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    peer.enterQuarantine("test miss")
    expect(peer.isQuarantined()).toBeTrue()
    const inner = (peer as unknown as { peer: unknown }).peer
    const next = peer.peekNextJsonRpcId()
    expect(await peer.initialize(300)).toBeFalse()
    expect(peer.isQuarantined()).toBeTrue()
    expect((peer as unknown as { peer: unknown }).peer).toBe(inner)
    expect(peer.peekNextJsonRpcId()).toBe(next)
    cleanup(peer, backendPeer, clientReader, clientWriter)
  })

  test("quarantine fallback warning uses sanitized labels only", async () => {
    const { clientReader, clientWriter, backendPeer } = hangingBackend(["session/update", "transport/health"])
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 44, epoch: 54, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    const warns: unknown[][] = []
    const orig = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      quarantinePeerOnTimeout(peer, "observer timeout exact cancel miss opId=ses_secret", 54)
    } finally {
      console.warn = orig
    }
    expect(peer.isQuarantined()).toBeTrue()
    const fallback = warns.filter((w) => String(w[0]).includes("observer timeout quarantines:"))
    expect(fallback.length).toBeGreaterThan(0)
    for (const w of fallback) {
      expect(String(w[0])).not.toContain("ses_secret")
      expect(String(w[0])).not.toContain("epoch 54")
      expect(JSON.stringify(w[1] ?? {})).toBe(JSON.stringify({ op: "quarantine", quarantined: true, invalidated: true }))
    }
    cleanup(peer, backendPeer, clientReader, clientWriter)
  })
})
