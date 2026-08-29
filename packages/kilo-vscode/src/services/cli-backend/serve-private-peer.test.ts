import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer, compareParity, canonicalCancelQueuedOpId, validateCancelQueuedRequest, validateCancelQueuedResult, getSdkHttpStatus } from "./serve-private-peer"

function createLinkedChannel(
  handler: (method: string, params: unknown) => unknown | Promise<unknown>,
): { clientReader: PassThrough; clientWriter: PassThrough; backendPeer: JsonRpcPeer } {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const backendPeer = new JsonRpcPeer({
    reader: toBackend,
    writer: toClient,
    onRequest: handler as unknown as (m: string, p: unknown) => unknown,
  })
  return { clientReader: toClient, clientWriter: toBackend, backendPeer }
}

describe("ServePrivatePeer B1", () => {
  test("canonical opId", () => {
    expect(canonicalCancelQueuedOpId("ses_123", "msg_456")).toBe("cancelQueued:ses_123:msg_456")
  })

  test("canonical opId and idempotencyKey exact legacy binding", () => {
    const sid = "ses_abc"
    const mid = "msg_def"
    const opId = canonicalCancelQueuedOpId(sid, mid)
    const idempotencyKey = `legacy:${sid}:${mid}`
    expect(opId).toBe("cancelQueued:ses_abc:msg_def")
    expect(idempotencyKey).toBe("legacy:ses_abc:msg_def")
    // request validation enforces canonical binding
    const req = { v: 1 as const, requestId: "r1", opId, op: "session/cancelQueued" as const, idempotencyKey, context: { directory: "/tmp", sessionId: sid }, payload: { messageId: mid } }
    expect(() => validateCancelQueuedRequest(req)).not.toThrow()
    const bad = { ...req, opId: "cancelQueued:ses_abc:msg_other" }
    expect(() => validateCancelQueuedRequest(bad)).toThrow()
  })

  test("init success with cancelQueued capability", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method) => {
      if (method === "initialize") {
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
      }
      throw new Error("unexpected")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 123, epoch: 1, initializeTimeoutMs: 500 })
    const ok = await peer.initialize(500)
    expect(ok).toBeTrue()
    expect(peer.isAvailable()).toBeTrue()
    expect(peer.getEpoch()).toBe(1)
    peer.dispose()
    expect(peer.isDisposed()).toBeTrue()
  })

  test("init timeout marks unavailable and never throws", async () => {
    const toClient = new PassThrough()
    const toBackend = new PassThrough()
    const peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 124, epoch: 2, initializeTimeoutMs: 100 })
    const ok = await peer.initialize(100)
    expect(ok).toBeFalse()
    expect(peer.isAvailable()).toBeFalse()
    peer.dispose()
  })

  test("init EOF marks unavailable", async () => {
    const toClient = new PassThrough()
    const toBackend = new PassThrough()
    toClient.end()
    const peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 125, epoch: 3, initializeTimeoutMs: 200 })
    const ok = await peer.initialize(200)
    expect(ok).toBeFalse()
    expect(peer.isAvailable()).toBeFalse()
    peer.dispose()
  })

  test("init unsupported major marks unavailable", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 2, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 126, epoch: 4, initializeTimeoutMs: 300 })
    const ok = await peer.initialize(300)
    expect(ok).toBeFalse()
    expect(peer.isAvailable()).toBeFalse()
    peer.dispose()
  })

  test("init missing capability marks unavailable", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: [] }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 127, epoch: 5, initializeTimeoutMs: 300 })
    const ok = await peer.initialize(300)
    expect(ok).toBeFalse()
    expect(peer.isAvailable()).toBeFalse()
    peer.dispose()
  })

  test("old CLI empty capabilities fallback unavailable", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method) => {
      if (method === "initialize") return { protocolVersion: "1.0", serverInfo: { name: "kilo-private-worker", version: "7.4.11" }, capabilities: {} }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 128, epoch: 6, initializeTimeoutMs: 300 })
    const ok = await peer.initialize(300)
    expect(ok).toBeFalse()
    expect(peer.isAvailable()).toBeFalse()
    peer.dispose()
  })

  test("fd unavailable null reader/writer marks unavailable", async () => {
    const peer = new ServePrivatePeer({ reader: null, writer: null, pid: 129, epoch: 7, initializeTimeoutMs: 100 })
    const ok = await peer.initialize(100)
    expect(ok).toBeFalse()
    expect(peer.isAvailable()).toBeFalse()
    peer.dispose()
  })

  test("initialize mutates availability only when peer and epoch still current", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method) => {
      if (method === "initialize") {
        await new Promise((r) => setTimeout(r, 80))
        return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
      }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 200, epoch: 20, initializeTimeoutMs: 500 })
    const p = peer.initialize(500)
    peer.dispose()
    const ok = await p
    expect(ok).toBeFalse()
    expect(peer.isAvailable()).toBeFalse()
    expect(peer.isDisposed()).toBeTrue()
  })

  test("privateCancelQueued success", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method, params) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
      if (method === "session/cancelQueued") {
        const req = params as { payload: { messageId: string }; requestId: string; opId: string; idempotencyKey: string }
        return { v: 1, requestId: req.requestId, opId: req.opId, op: "session/cancelQueued", idempotencyKey: req.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { cancelled: true }, revision: { session: 5, config: 2 } }
      }
      throw new Error("unexpected")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 130, epoch: 8, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    const req = { v: 1 as const, requestId: "req1", opId: "cancelQueued:ses_a:msg_b", op: "session/cancelQueued" as const, idempotencyKey: "idem1", context: { directory: "/tmp", sessionId: "ses_a" }, payload: { messageId: "msg_b" } }
    const res = await peer.privateCancelQueued(req)
    expect(res.status).toBe("succeeded")
    if (res.status === "succeeded") expect(res.data.cancelled).toBeTrue()
    peer.dispose()
  })

  test("privateCancelQueued strict envelope validation — mismatched requestId returns internal failed", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method, params) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
      if (method === "session/cancelQueued") {
        const req = params as { requestId: string; opId: string; idempotencyKey: string }
        return { v: 1, requestId: "wrong-" + req.requestId, opId: req.opId, op: "session/cancelQueued", idempotencyKey: req.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { cancelled: true } }
      }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 1310, epoch: 81, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    const req = { v: 1 as const, requestId: "req-valid", opId: "cancelQueued:ses_a:msg_b", op: "session/cancelQueued" as const, idempotencyKey: "idem1", context: { directory: "/tmp", sessionId: "ses_a" }, payload: { messageId: "msg_b" } }
    const res = await peer.privateCancelQueued(req)
    expect(res.status).toBe("failed")
    if (res.status === "failed") expect(res.failure.code).toBe("internal")
    peer.dispose()
  })

  test("privateCancelQueued strict envelope validation — bad status shape returns internal", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
      if (method === "session/cancelQueued") return { v: 1, requestId: "req2", opId: "cancelQueued:ses_a:msg_b", op: "session/cancelQueued", idempotencyKey: "idem2", status: "weird", outcome: { type: "weird", time: Date.now() }, accepted: true }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 1311, epoch: 82, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    const req = { v: 1 as const, requestId: "req2", opId: "cancelQueued:ses_a:msg_b", op: "session/cancelQueued" as const, idempotencyKey: "idem2", context: { directory: "/tmp", sessionId: "ses_a" }, payload: { messageId: "msg_b" } }
    const res = await peer.privateCancelQueued(req)
    expect(res.status).toBe("failed")
    peer.dispose()
  })

  test("pending rejection on exit returns ambiguous transport-unknown", async () => {
    const toClient = new PassThrough()
    const toBackend = new PassThrough()
    const backendPeer = new JsonRpcPeer({
      reader: toBackend,
      writer: toClient,
      onRequest: async (method) => {
        if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
        return new Promise(() => {})
      },
    })
    const peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 131, epoch: 9, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    const req = { v: 1 as const, requestId: "req2", opId: "cancelQueued:ses_a:msg_b", op: "session/cancelQueued" as const, idempotencyKey: "idem2", context: { directory: "/tmp", sessionId: "ses_a" }, payload: { messageId: "msg_b" } }
    const p = peer.privateCancelQueued(req)
    setTimeout(() => {
      toClient.end()
      backendPeer.dispose()
    }, 30)
    const res = await p
    expect(res.status).toBe("ambiguous")
    expect((res as unknown as { transportUnknown?: boolean }).transportUnknown).toBeTrue()
    peer.dispose()
  })

  test("stale old response dropped does not enter new epoch", async () => {
    const { clientReader: r1, clientWriter: w1 } = createLinkedChannel(async (method, params) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
      if (method === "session/cancelQueued") {
        await new Promise((res) => setTimeout(res, 200))
        const req = params as { requestId: string; opId: string; idempotencyKey: string }
        return { v: 1, requestId: req.requestId, opId: req.opId, op: "session/cancelQueued", idempotencyKey: req.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { cancelled: true } }
      }
      throw new Error("x")
    })
    const peer1 = new ServePrivatePeer({ reader: r1, writer: w1, pid: 132, epoch: 10, initializeTimeoutMs: 300 })
    expect(await peer1.initialize(300)).toBeTrue()
    const req = { v: 1 as const, requestId: "req3", opId: "cancelQueued:ses_a:msg_c", op: "session/cancelQueued" as const, idempotencyKey: "idem3", context: { directory: "/tmp", sessionId: "ses_a" }, payload: { messageId: "msg_c" } }
    const p1 = peer1.privateCancelQueued(req)
    const { clientReader: r2, clientWriter: w2 } = createLinkedChannel(async (method, params) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
      if (method === "session/cancelQueued") {
        const req2 = params as { requestId: string; opId: string; idempotencyKey: string }
        return { v: 1, requestId: req2.requestId, opId: req2.opId, op: "session/cancelQueued", idempotencyKey: req2.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { cancelled: false } }
      }
      throw new Error("x")
    })
    const peer2 = new ServePrivatePeer({ reader: r2, writer: w2, pid: 132, epoch: 11, initializeTimeoutMs: 300 })
    expect(await peer2.initialize(300)).toBeTrue()
    const res2 = await peer2.privateCancelQueued({ v: 1, requestId: "req4", opId: "cancelQueued:ses_a:msg_d", op: "session/cancelQueued", idempotencyKey: "idem4", context: { directory: "/tmp", sessionId: "ses_a" }, payload: { messageId: "msg_d" } })
    expect(res2.status).toBe("succeeded")
    if (res2.status === "succeeded") expect(res2.data.cancelled).toBeFalse()
    const res1 = await p1
    expect(res1.status).toBe("succeeded")
    if (res1.status === "succeeded") expect(res1.data.cancelled).toBeTrue()
    expect(peer1.getEpoch()).toBe(10)
    expect(peer2.getEpoch()).toBe(11)
    peer1.dispose()
    peer2.dispose()
  })

  test("compareParity detects divergences", () => {
    const sdkSuccessTrue = { data: true, error: undefined }
    const privSuccessTrue = { v: 1, requestId: "r", opId: "o", op: "session/cancelQueued", idempotencyKey: "i", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: { cancelled: true } } as unknown as Parameters<typeof compareParity>[0]
    const { divergence: d1 } = compareParity(privSuccessTrue, sdkSuccessTrue)
    expect(d1).toBeNull()

    const privSuccessFalse = { v: 1, requestId: "r", opId: "o", op: "session/cancelQueued", idempotencyKey: "i", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: { cancelled: false } } as unknown as Parameters<typeof compareParity>[0]
    const { divergence: d2 } = compareParity(privSuccessFalse, sdkSuccessTrue)
    expect(d2).toContain("cancelled-mismatch")

    const sdkFailed409 = { data: undefined, error: { status: 409 } }
    const privFailedStale = { v: 1, requestId: "r", opId: "o", op: "session/cancelQueued", idempotencyKey: "i", status: "failed", outcome: { type: "failed", time: 1, failure: { code: "stale", message: "x", retryable: false } }, accepted: false, failure: { code: "stale", message: "x", retryable: false } } as unknown as Parameters<typeof compareParity>[0]
    const { divergence: d3 } = compareParity(privFailedStale, sdkFailed409)
    expect(d3).toBeNull()

    const privFailedOther = { v: 1, requestId: "r", opId: "o", op: "session/cancelQueued", idempotencyKey: "i", status: "failed", outcome: { type: "failed", time: 1, failure: { code: "scope_mismatch", message: "x", retryable: false } }, accepted: false, failure: { code: "scope_mismatch", message: "x", retryable: false } } as unknown as Parameters<typeof compareParity>[0]
    const { divergence: d4 } = compareParity(privFailedOther, sdkFailed409)
    expect(d4).toContain("failure-class-mismatch")

    const privAmbiguous = { v: 1, requestId: "r", opId: "o", op: "session/cancelQueued", idempotencyKey: "i", status: "ambiguous", outcome: { type: "ambiguous", time: 1 }, accepted: false, transportUnknown: true } as unknown as Parameters<typeof compareParity>[0]
    const { divergence: d5 } = compareParity(privAmbiguous, sdkSuccessTrue)
    expect(d5).toBe("transport-unknown")

    const sdk500 = { data: undefined, error: { status: 500 } }
    const privInternal = { v: 1, requestId: "r", opId: "o", op: "session/cancelQueued", idempotencyKey: "i", status: "failed", outcome: { type: "failed", time: 1, failure: { code: "internal", message: "x", retryable: false } }, accepted: false, failure: { code: "internal", message: "x", retryable: false } } as unknown as Parameters<typeof compareParity>[0]
    const { divergence: d6 } = compareParity(privInternal, sdk500)
    expect(d6).toBeNull()

    const sdk404 = { data: undefined, error: { status: 404 } }
    const privNotFound = { v: 1, requestId: "r", opId: "o", op: "session/cancelQueued", idempotencyKey: "i", status: "failed", outcome: { type: "failed", time: 1, failure: { code: "session.not_found", message: "x", retryable: false } }, accepted: false, failure: { code: "session.not_found", message: "x", retryable: false } } as unknown as Parameters<typeof compareParity>[0]
    const { divergence: d7 } = compareParity(privNotFound, sdk404)
    expect(d7).toBeNull()

    const sdk400 = { data: undefined, error: { status: 400 } }
    const privValidation = { v: 1, requestId: "r", opId: "o", op: "session/cancelQueued", idempotencyKey: "i", status: "failed", outcome: { type: "failed", time: 1, failure: { code: "validation.failed", message: "x", retryable: false } }, accepted: false, failure: { code: "validation.failed", message: "x", retryable: false } } as unknown as Parameters<typeof compareParity>[0]
    const { divergence: d8 } = compareParity(privValidation, sdk400)
    expect(d8).toBeNull()

    const privAmbiguousReal = { v: 1, requestId: "r", opId: "o", op: "session/cancelQueued", idempotencyKey: "i", status: "ambiguous", outcome: { type: "ambiguous", time: 1 }, accepted: false } as unknown as Parameters<typeof compareParity>[0]
    const { divergence: d9 } = compareParity(privAmbiguousReal, sdkFailed409)
    expect(d9).toBeNull()
  })

  test("validateCancelQueuedResult enforces identity and shape", () => {
    const req = { v: 1 as const, requestId: "r1", opId: "cancelQueued:ses_a:msg_b", op: "session/cancelQueued" as const, idempotencyKey: "idem1", context: { directory: "/tmp", sessionId: "ses_a" }, payload: { messageId: "msg_b" } }
    const good = { v: 1, requestId: "r1", opId: "cancelQueued:ses_a:msg_b", op: "session/cancelQueued", idempotencyKey: "idem1", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: { cancelled: true } }
    expect(() => validateCancelQueuedResult(good, req)).not.toThrow()
    const badId = { ...good, requestId: "r2" }
    expect(() => validateCancelQueuedResult(badId, req)).toThrow()
    const badAccepted = { ...good, accepted: false }
    expect(() => validateCancelQueuedResult(badAccepted, req)).toThrow()
  })

  test("privateCancelQueued after dispose throws", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 133, epoch: 12, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    peer.dispose()
    const req = { v: 1 as const, requestId: "req", opId: "cancelQueued:ses:msg", op: "session/cancelQueued" as const, idempotencyKey: "idem", context: { directory: "/tmp", sessionId: "ses" }, payload: { messageId: "msg" } }
    await expect(peer.privateCancelQueued(req)).rejects.toThrow()
  })

  test("idempotent dispose", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 134, epoch: 13, initializeTimeoutMs: 300 })
    await peer.initialize(300)
    peer.dispose()
    peer.dispose()
    expect(peer.isDisposed()).toBeTrue()
  })

  test("initialize fails closed on wrong protocol name", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method) => {
      if (method === "initialize") return { protocol: { name: "wrong-name", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 135, epoch: 14, initializeTimeoutMs: 300 })
    const ok = await peer.initialize(300)
    expect(ok).toBeFalse()
    expect(peer.isAvailable()).toBeFalse()
    peer.dispose()
  })

  test("initialize fails closed on missing protocol name", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method) => {
      if (method === "initialize") return { protocol: { major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 136, epoch: 15, initializeTimeoutMs: 300 })
    const ok = await peer.initialize(300)
    expect(ok).toBeFalse()
    expect(peer.isAvailable()).toBeFalse()
    peer.dispose()
  })

  test("getSdkHttpStatus extracts actual SDK tuple response.status before error heuristics", () => {
    expect(getSdkHttpStatus({ response: { status: 404 }, error: { _tag: "BadRequest" } })).toBe(404)
    expect(getSdkHttpStatus({ response: { status: 409 }, error: undefined })).toBe(409)
    expect(getSdkHttpStatus({ response: { status: 200 }, error: { status: 500 } })).toBe(200)
    expect(getSdkHttpStatus({ response: undefined, error: { status: 404 } })).toBeNull()
    expect(getSdkHttpStatus({ response: { status: "404" } as unknown as { status: number }, error: undefined })).toBe(404)
  })

  test("compareParity uses response.status for 404/409 divergence", () => {
    const privFailedNotFound = { v: 1, requestId: "r", opId: "o", op: "session/cancelQueued", idempotencyKey: "i", status: "failed", outcome: { type: "failed", time: 1, failure: { code: "session.not_found", message: "x", retryable: false } }, accepted: false, failure: { code: "session.not_found", message: "x", retryable: false } } as unknown as Parameters<typeof compareParity>[0]
    const sdk404 = { data: undefined, error: { message: "not found" }, response: { status: 404 } }
    const { divergence: d404 } = compareParity(privFailedNotFound, sdk404 as unknown as Parameters<typeof compareParity>[1])
    expect(d404).toBeNull()

    const privFailedStale = { v: 1, requestId: "r", opId: "o", op: "session/cancelQueued", idempotencyKey: "i", status: "failed", outcome: { type: "failed", time: 1, failure: { code: "stale", message: "x", retryable: false } }, accepted: false, failure: { code: "stale", message: "x", retryable: false } } as unknown as Parameters<typeof compareParity>[0]
    const sdk409 = { data: undefined, error: { message: "conflict" }, response: { status: 409 } }
    const { divergence: d409 } = compareParity(privFailedStale, sdk409 as unknown as Parameters<typeof compareParity>[1])
    expect(d409).toBeNull()

    // response.status takes precedence over error body heuristics: error says 500 but response is 404 => treat as 404
    const sdkMismatch = { data: undefined, error: { status: 500 }, response: { status: 404 } }
    const privMismatch = { v: 1, requestId: "r", opId: "o", op: "session/cancelQueued", idempotencyKey: "i", status: "failed", outcome: { type: "failed", time: 1, failure: { code: "internal", message: "x", retryable: false } }, accepted: false, failure: { code: "internal", message: "x", retryable: false } } as unknown as Parameters<typeof compareParity>[0]
    const { divergence: dMis } = compareParity(privMismatch, sdkMismatch as unknown as Parameters<typeof compareParity>[1])
    expect(dMis).toContain("failure-class-mismatch")
  })

  test("validateCancelQueuedResult rejects inconsistent failure facts", () => {
    const req = { v: 1 as const, requestId: "r1", opId: "cancelQueued:ses_a:msg_b", op: "session/cancelQueued" as const, idempotencyKey: "idem1", context: { directory: "/tmp", sessionId: "ses_a" }, payload: { messageId: "msg_b" } }
    const baseFailed = { v: 1, requestId: "r1", opId: "cancelQueued:ses_a:msg_b", op: "session/cancelQueued", idempotencyKey: "idem1", status: "failed", outcome: { type: "failed", time: 1, failure: { code: "stale", message: "msg", retryable: false } }, accepted: false, failure: { code: "stale", message: "msg", retryable: false } }
    // message mismatch should throw
    const badMsg = { ...baseFailed, failure: { code: "stale", message: "different", retryable: false } }
    expect(() => validateCancelQueuedResult(badMsg, req)).toThrow()
    // retryable mismatch
    const badRetry = { ...baseFailed, failure: { code: "stale", message: "msg", retryable: true }, outcome: { type: "failed", time: 1, failure: { code: "stale", message: "msg", retryable: false } } }
    expect(() => validateCancelQueuedResult(badRetry, req)).toThrow()
    // status-incompatible: succeeded with failure
    const succeededWithFailure = { v: 1, requestId: "r1", opId: "cancelQueued:ses_a:msg_b", op: "session/cancelQueued", idempotencyKey: "idem1", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: { cancelled: true }, failure: { code: "x", message: "y", retryable: false } }
    expect(() => validateCancelQueuedResult(succeededWithFailure, req)).toThrow()
    // ambiguous with failure
    const ambWithFailure = { v: 1, requestId: "r1", opId: "cancelQueued:ses_a:msg_b", op: "session/cancelQueued", idempotencyKey: "idem1", status: "ambiguous", outcome: { type: "ambiguous", time: 1 }, accepted: false, failure: { code: "x", message: "y", retryable: false } }
    expect(() => validateCancelQueuedResult(ambWithFailure, req)).toThrow()
  })
})
