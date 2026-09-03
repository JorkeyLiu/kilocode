import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer, compareMessagesParity } from "./serve-private-peer"
import { canonicalMessagesOpId } from "./serve-private-messages"

function makeReq() {
  const sessionId = "ses_abc"
  const opId = canonicalMessagesOpId(sessionId, "tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "session/messages" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp", sessionId },
    payload: {},
  }
}

function msgItem(id: string, created: number) {
  return { info: { id, sessionID: "ses_abc", role: "user", time: { created } }, parts: [] }
}

function makeSuccess(req: ReturnType<typeof makeReq>, messages: unknown[] = [], nextCursor?: string) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/messages",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: nextCursor !== undefined ? { messages, nextCursor } : { messages },
  }
}

function makeFailed(req: ReturnType<typeof makeReq>, code: string) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "session/messages",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "x", retryable: false } },
    accepted: false,
    failure: { code, message: "x", retryable: false },
  }
}

function sdkSuccess(items: unknown[], cursor: string | null) {
  return {
    data: items,
    error: undefined,
    response: { status: 200, headers: { get: (k: string) => (k === "X-Next-Cursor" ? cursor : null) } },
  }
}

describe("B7 residuals: complete payload + safe-summary-only diagnostics", () => {
  test("unequal nonempty cursor values diverge without value leakage", () => {
    const req = makeReq()
    const items = [msgItem("msg_1", 1)]
    const priv = makeSuccess(req, items, "priv-cursor-secret-aaa") as unknown as Parameters<typeof compareMessagesParity>[0]
    const sdk = sdkSuccess(items, "sdk-cursor-secret-bbb") as unknown as Parameters<typeof compareMessagesParity>[1]
    const res = compareMessagesParity(priv, sdk)
    expect(res.divergence).toBe("observation-divergence:cursor-mismatch")
    const serialized = JSON.stringify(res)
    expect(serialized.includes("priv-cursor-secret-aaa")).toBeFalse()
    expect(serialized.includes("sdk-cursor-secret-bbb")).toBeFalse()
    expect(res.details).toEqual({ sdkCount: 1, privCount: 1, sdkCursor: true, privCursor: true })
    // Equal nonempty values still match.
    const samePriv = makeSuccess(req, items, "same-cursor") as unknown as Parameters<typeof compareMessagesParity>[0]
    const sameSdk = sdkSuccess(items, "same-cursor") as unknown as Parameters<typeof compareMessagesParity>[1]
    expect(compareMessagesParity(samePriv, sameSdk).divergence).toBeNull()
  })

  test("malicious failure code is never logged", () => {
    const req = makeReq()
    const evil = "evil-backend-code-ses_secret-xyz-req_secret"
    const sdk404 = { error: { status: 404 }, response: { status: 404 } } as unknown as Parameters<typeof compareMessagesParity>[1]
    const privEvil = makeFailed(req, evil) as unknown as Parameters<typeof compareMessagesParity>[0]
    const res = compareMessagesParity(privEvil, sdk404)
    expect(res.divergence).toBe("failure-class-mismatch")
    const serialized = JSON.stringify(res)
    expect(serialized.includes(evil)).toBeFalse()
    expect(serialized.includes("ses_secret")).toBeFalse()
    // Fallback code path (non-400/404/409/500) also hides both codes.
    const sdk429 = {
      error: { code: "sdk-secret-code-abc" },
      response: { status: 429 },
    } as unknown as Parameters<typeof compareMessagesParity>[1]
    const privEvil2 = makeFailed(req, evil) as unknown as Parameters<typeof compareMessagesParity>[0]
    const res2 = compareMessagesParity(privEvil2, sdk429)
    expect(res2.divergence).toBe("failure-code-mismatch")
    const serialized2 = JSON.stringify(res2)
    expect(serialized2.includes(evil)).toBeFalse()
    expect(serialized2.includes("sdk-secret-code-abc")).toBeFalse()
    expect(res2.details).toEqual({ sdkCodePresent: true })
  })

  test("legacy privateMessages cancel/invalidate paths never log identity-like errors", async () => {
    const { KiloConnectionService } = await import("./connection-service")
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const secret = "ses_identity-secret-123-opaque"
      const mkSvc = () => new KiloConnectionService({} as never) as unknown as Record<string, unknown>
      // Cancel throw path.
      const svc = mkSvc()
      const peerThrow = {
        privateMessagesWithHandle: () => ({ id: 1, promise: Promise.resolve({}) }),
        tryCancelPending: () => {
          throw new Error(`boom ${secret} opId=messages:${secret}:tok requestId=req-${secret}`)
        },
        invalidateOnObserverTimeout: () => {},
        isAvailable: () => true,
        hasCapability: () => true,
      }
      svc.privatePeer = peerThrow
      svc.privateAvailable = true
      svc.privateEpoch = 9
      const req = makeReq() as never
      const handle = (svc as unknown as { privateMessagesWithHandle: (r: never) => { cancel: (m?: string) => boolean } }).privateMessagesWithHandle(req)
      // Suppress inner invalidation warn noise for this sub-case by stubbing owner invalidate.
      ;(svc as unknown as { invalidatePrivatePeerOnObserverTimeout: (r: string) => void }).invalidatePrivatePeerOnObserverTimeout = () => {}
      warns.length = 0
      expect(handle.cancel()).toBeFalse()
      expect(warns.map((w) => w.map(String).join(" ")).join(" ").includes(secret)).toBeFalse()
      try {
        ;(svc as unknown as { dispose: () => void }).dispose()
      } catch {}
      // Stale cleanup throw path.
      const svc2 = mkSvc()
      const peerStale = {
        privateMessagesWithHandle: () => ({ id: 2, promise: Promise.resolve({}) }),
        tryCancelPending: () => true,
        invalidateOnObserverTimeout: () => {
          throw new Error(`stale boom ${secret}`)
        },
        isAvailable: () => true,
        hasCapability: () => true,
      }
      svc2.privatePeer = peerStale
      svc2.privateAvailable = true
      svc2.privateEpoch = 9
      const handle2 = (svc2 as unknown as { privateMessagesWithHandle: (r: never) => { cancel: (m?: string) => boolean } }).privateMessagesWithHandle(req)
      // Drift epoch so cancel takes the stale branch.
      svc2.privateEpoch = 10
      warns.length = 0
      expect(handle2.cancel()).toBeFalse()
      expect(warns.map((w) => w.map(String).join(" ")).join(" ").includes(secret)).toBeFalse()
      try {
        ;(svc2 as unknown as { dispose: () => void }).dispose()
      } catch {}
      // Exact-cancel miss invalidate throw path.
      const svc3 = mkSvc()
      const peerMiss = {
        privateMessagesWithHandle: () => ({ id: 3, promise: Promise.resolve({}) }),
        tryCancelPending: () => false,
        isAvailable: () => true,
        hasCapability: () => true,
      }
      svc3.privatePeer = peerMiss
      svc3.privateAvailable = true
      svc3.privateEpoch = 9
      ;(svc3 as unknown as { invalidatePrivatePeerOnObserverTimeout: (r: string) => void }).invalidatePrivatePeerOnObserverTimeout = () => {
        throw new Error(`invalidate boom ${secret}`)
      }
      const handle3 = (svc3 as unknown as { privateMessagesWithHandle: (r: never) => { cancel: (m?: string) => boolean } }).privateMessagesWithHandle(req)
      warns.length = 0
      expect(handle3.cancel()).toBeFalse()
      expect(warns.map((w) => w.map(String).join(" ")).join(" ").includes(secret)).toBeFalse()
      try {
        ;(svc3 as unknown as { dispose: () => void }).dispose()
      } catch {}
    } finally {
      console.warn = origWarn
    }
  })

  test("B7 peer invalidate disposal never logs raw error; other ops preserve legacy detail", async () => {
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const mkPeer = () => {
        const toClient = new PassThrough()
        const toBackend = new PassThrough()
        const peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, epoch: 5 })
        return { peer, toClient, toBackend }
      }
      const secret = "ses_dispose-secret-xyz"
      const { peer, toClient, toBackend } = mkPeer()
      const origDispose = peer.dispose.bind(peer)
      peer.dispose = () => {
        origDispose()
        throw new Error(`dispose boom ${secret} opId=messages:${secret}:tok`)
      }
      warns.length = 0
      peer.invalidateOnObserverTimeout("observer timeout exact cancel miss")
      expect(warns.map((w) => w.map(String).join(" ")).join(" ").includes(secret)).toBeFalse()
      expect(warns.some((w) => String(w[0]).includes("observer timeout invalidates epoch"))).toBeTrue()
      toClient.destroy()
      toBackend.destroy()
      // Legacy (non-B7) reason still carries its detail string.
      const second = mkPeer()
      warns.length = 0
      second.peer.invalidateOnObserverTimeout("observer timeout exact cancel miss opId=messages:ses_abc:tok1")
      const logged = warns.map((w) => w.map(String).join(" ")).join(" ")
      expect(logged.includes("messages:ses_abc:tok1")).toBeTrue()
      second.toClient.destroy()
      second.toBackend.destroy()
      void JsonRpcPeer
    } finally {
      console.warn = origWarn
    }
  })

  test("connection invalidate wrapper hides raw dispose error for B7 only", async () => {
    const { KiloConnectionService } = await import("./connection-service")
    const warns: unknown[][] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args)
    }
    try {
      const secret = "ses_wrapper-secret-999"
      const svc = new KiloConnectionService({} as never) as unknown as Record<string, unknown>
      svc.privatePeer = {
        invalidateOnObserverTimeout: () => {
          throw new Error(`wrapper boom ${secret}`)
        },
      }
      svc.privateAvailable = true
      svc.privateEpoch = 7
      warns.length = 0
      ;(svc as unknown as { invalidatePrivatePeerOnObserverTimeout: (r: string) => void }).invalidatePrivatePeerOnObserverTimeout("messages observer timeout")
      expect(warns.map((w) => w.map(String).join(" ")).join(" ").includes(secret)).toBeFalse()
      try {
        ;(svc as unknown as { dispose: () => void }).dispose()
      } catch {}
    } finally {
      console.warn = origWarn
    }
  })
})
