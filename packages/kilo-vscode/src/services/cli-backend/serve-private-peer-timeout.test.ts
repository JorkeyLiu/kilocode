import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"

function createHangingChannel(capabilities: string[]): { clientReader: PassThrough; clientWriter: PassThrough; backendPeer: JsonRpcPeer } {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const backendPeer = new JsonRpcPeer({
    reader: toBackend,
    writer: toClient,
    onRequest: async (method) => {
      if (method === "initialize") {
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities }
      }
      // hang forever for session/* methods
      return new Promise(() => {})
    },
  })
  return { clientReader: toClient, clientWriter: toBackend, backendPeer }
}

describe("ServePrivatePeer timeout ownership — update/cancelQueued no pending leak", () => {
  test("update handle cancel removes owned pending without leak", async () => {
    const { clientReader, clientWriter, backendPeer } = createHangingChannel(["session/update", "session/cancelQueued", "session/fork", "session/create"])
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 901, epoch: 91, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    expect(peer.isAvailable()).toBeTrue()
    expect(peer.getPendingCount()).toBe(0)

    const req = {
      v: 1 as const,
      requestId: "req-update-1",
      opId: "sessionUpdate:ses_aaa:tok1",
      op: "session/update" as const,
      idempotencyKey: "sessionUpdate:ses_aaa:tok1",
      context: { directory: "/tmp", sessionId: "ses_aaa", parentSessionId: null },
      payload: { title: "new title" },
    }
    const handle = peer.privateSessionUpdateWithHandle(req)
    expect(typeof handle.id).toBe("number")
    expect(handle.id).toBeGreaterThan(0)
    expect(peer.getPendingCount()).toBe(1)
    expect(peer.peekNextJsonRpcId()).toBeGreaterThan(handle.id)

    const cancelled = handle.cancel("private parity timeout opId=sessionUpdate:ses_aaa:tok1")
    expect(cancelled).toBeTrue()
    expect(peer.getPendingCount()).toBe(0)
    // cancelled pending settles as ambiguous transportUnknown (peerClosed mapping for InternalError) — crucial is no leak, not failed
    const res = await handle.promise
    expect(res.status).toBe("ambiguous")
    expect((res as unknown as { transportUnknown?: boolean }).transportUnknown).toBeTrue()
    expect(peer.getPendingCount()).toBe(0)

    // second exact cancel miss quarantines same peer (bounded recovery, no rebuild)
    const second = handle.cancel("private parity timeout opId=sessionUpdate:ses_aaa:tok1")
    expect(second).toBeFalse()
    expect(peer.isAvailable()).toBeFalse()
    expect(peer.isQuarantined()).toBeTrue()
    expect(peer.isDisposed()).toBeFalse()
    expect(peer.getLifecycleState()).toBe("quarantined")

    peer.dispose()
    backendPeer.dispose()
    try { clientReader.destroy() } catch {}
    try { clientWriter.destroy() } catch {}
  })

  test("cancelQueued handle cancel removes owned pending without leak", async () => {
    const { clientReader, clientWriter, backendPeer } = createHangingChannel(["session/update", "session/cancelQueued", "session/fork", "session/create"])
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 902, epoch: 92, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()

    const req = {
      v: 1 as const,
      requestId: "req-cancel-1",
      opId: "cancelQueued:ses_bbb:msg_ccc",
      op: "session/cancelQueued" as const,
      idempotencyKey: "legacy:ses_bbb:msg_ccc",
      context: { directory: "/tmp", sessionId: "ses_bbb" },
      payload: { messageId: "msg_ccc" },
    }
    const handle = peer.privateCancelQueuedWithHandle(req)
    expect(peer.getPendingCount()).toBe(1)
    const ok = handle.cancel("private parity timeout opId=cancelQueued:ses_bbb:msg_ccc")
    expect(ok).toBeTrue()
    expect(peer.getPendingCount()).toBe(0)
    const res = await handle.promise
    expect(res.status).toBe("ambiguous")
    expect((res as unknown as { transportUnknown?: boolean }).transportUnknown).toBeTrue()
    expect(peer.getPendingCount()).toBe(0)

    const second = handle.cancel("private parity timeout opId=cancelQueued:ses_bbb:msg_ccc")
    expect(second).toBeFalse()
    expect(peer.isAvailable()).toBeFalse()

    peer.dispose()
    backendPeer.dispose()
    try { clientReader.destroy() } catch {}
    try { clientWriter.destroy() } catch {}
  })

  test("update timeout via KiloProvider-style withTimeout must cancel exact id, not peek fallback", async () => {
    const { clientReader, clientWriter, backendPeer } = createHangingChannel(["session/update", "session/cancelQueued"])
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 903, epoch: 93, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()

    const req = {
      v: 1 as const,
      requestId: "req-update-timeout",
      opId: "sessionUpdate:ses_timeout:tok2",
      op: "session/update" as const,
      idempotencyKey: "sessionUpdate:ses_timeout:tok2",
      context: { directory: "/tmp", sessionId: "ses_timeout", parentSessionId: null },
      payload: { title: "hang" },
    }
    const handle = peer.privateSessionUpdateWithHandle(req)
    expect(peer.getPendingCount()).toBe(1)
    const exact = handle.id

    // Simulate KiloProvider withTimeout race: timeout wins, then cancel exact handle
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`private parity timeout after ${ms}ms`)), ms)
        ;(timer as unknown as { unref?: () => void })?.unref?.()
      })
      return Promise.race([p, timeout]).finally(() => {
        if (timer) clearTimeout(timer)
      }) as Promise<T>
    }
    const raced = await withTimeout(handle.promise, 20).catch((e: unknown) => {
      const msg = String(e)
      if (msg.includes("private parity timeout")) {
        const cleaned = handle.cancel(`private parity timeout opId=${req.opId}`)
        expect(cleaned).toBeTrue()
        expect(peer.getPendingCount()).toBe(0)
      }
      return {
        v: 1,
        requestId: req.requestId,
        opId: req.opId,
        op: "session/update",
        idempotencyKey: req.idempotencyKey,
        status: "ambiguous",
        outcome: { type: "ambiguous", time: Date.now() },
        accepted: false,
        transportUnknown: true,
      }
    })
    expect((raced as { status: string }).status).toBe("ambiguous")
    expect(peer.getPendingCount()).toBe(0)
    expect(exact).toBeGreaterThan(0)

    peer.dispose()
    backendPeer.dispose()
    try { clientReader.destroy() } catch {}
    try { clientWriter.destroy() } catch {}
  })
})
