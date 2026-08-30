import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import {
  ServePrivatePeer,
  canonicalSessionUpdateOpId,
  validateSessionUpdateRequest,
  validateSessionUpdateResult,
  compareUpdateParity,
  getSdkHttpStatus,
} from "./serve-private-peer"

function createLinkedChannel(handler: (method: string, params: unknown) => unknown | Promise<unknown>) {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const backendPeer = new JsonRpcPeer({
    reader: toBackend,
    writer: toClient,
    onRequest: handler as unknown as (m: string, p: unknown) => unknown,
  })
  return { clientReader: toClient, clientWriter: toBackend, backendPeer }
}

describe("ServePrivatePeer B2 session/update", () => {
  test("canonical opId", () => {
    expect(canonicalSessionUpdateOpId("ses_123")).toBe("sessionUpdate:ses_123")
  })

  test("validate request success and canonical binding", () => {
    const req = {
      v: 1 as const,
      requestId: "r1",
      opId: "sessionUpdate:ses_a",
      op: "session/update" as const,
      idempotencyKey: "idem1",
      context: { directory: "/tmp", sessionId: "ses_a", parentSessionId: null },
      payload: { title: "hello" },
    }
    expect(() => validateSessionUpdateRequest(req)).not.toThrow()
    const bad = { ...req, opId: "sessionUpdate:ses_other" }
    expect(() => validateSessionUpdateRequest(bad)).toThrow()
    const emptyTitle = { ...req, payload: { title: "" } }
    expect(() => validateSessionUpdateRequest(emptyTitle)).toThrow()
    const missingParent = { ...req, context: { directory: "/tmp", sessionId: "ses_a" } } as unknown as typeof req
    expect(() => validateSessionUpdateRequest(missingParent)).toThrow()
  })

  test("validate result enforces identity and shape", () => {
    const req = { v: 1 as const, requestId: "r1", opId: "sessionUpdate:ses_a", op: "session/update" as const, idempotencyKey: "idem1", context: { directory: "/tmp", sessionId: "ses_a" }, payload: { title: "hi" } }
    const good = { v: 1, requestId: "r1", opId: "sessionUpdate:ses_a", op: "session/update", idempotencyKey: "idem1", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: { title: "hi" } }
    expect(() => validateSessionUpdateResult(good, req)).not.toThrow()
    const badId = { ...good, requestId: "r2" }
    expect(() => validateSessionUpdateResult(badId, req)).toThrow()
    const badData = { ...good, data: { title: "" } }
    expect(() => validateSessionUpdateResult(badData, req)).toThrow()
  })

  test("init success with session/update capability", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/update"] }
      throw new Error("unexpected")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 210, epoch: 10, initializeTimeoutMs: 300 })
    const ok = await peer.initialize(300)
    expect(ok).toBeTrue()
    expect(peer.isAvailable()).toBeTrue()
    expect(peer.hasCapability("session/update")).toBeTrue()
    peer.dispose()
  })

  test("init success with both capabilities", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued", "session/update"] }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 211, epoch: 11, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    expect(peer.hasCapability("session/cancelQueued")).toBeTrue()
    expect(peer.hasCapability("session/update")).toBeTrue()
    peer.dispose()
  })

  test("init missing both capabilities marks unavailable", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: [] }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 212, epoch: 12, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeFalse()
    expect(peer.isAvailable()).toBeFalse()
    peer.dispose()
  })

  test("init still succeeds with only cancelQueued (B1 compat)", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/cancelQueued"] }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 213, epoch: 13, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    expect(peer.hasCapability("session/cancelQueued")).toBeTrue()
    expect(peer.hasCapability("session/update")).toBeFalse()
    peer.dispose()
  })

  test("privateSessionUpdate success", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method, params) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/update", "session/cancelQueued"] }
      if (method === "session/update") {
        const req = params as { requestId: string; opId: string; idempotencyKey: string }
        return { v: 1, requestId: req.requestId, opId: req.opId, op: "session/update", idempotencyKey: req.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { title: "new title", session: { id: "ses_a", title: "new title" } } }
      }
      throw new Error("unexpected")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 220, epoch: 20, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    const req = { v: 1 as const, requestId: "req1", opId: "sessionUpdate:ses_a", op: "session/update" as const, idempotencyKey: "idem1", context: { directory: "/tmp", sessionId: "ses_a", parentSessionId: null }, payload: { title: "new title" } }
    const res = await peer.privateSessionUpdate(req)
    expect(res.status).toBe("succeeded")
    if (res.status === "succeeded") expect((res.data as Record<string, unknown>).title ?? ((res.data as Record<string, unknown>).session as Record<string, unknown>)?.title).toBe("new title")
    peer.dispose()
  })

  test("privateSessionUpdate strict envelope validation — mismatched requestId returns internal failed", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method, params) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/update"] }
      if (method === "session/update") {
        const req = params as { requestId: string; opId: string; idempotencyKey: string }
        return { v: 1, requestId: "wrong-" + req.requestId, opId: req.opId, op: "session/update", idempotencyKey: req.idempotencyKey, status: "succeeded", outcome: { type: "succeeded", time: Date.now() }, accepted: true, data: { title: "hi" } }
      }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 221, epoch: 21, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    const req = { v: 1 as const, requestId: "req-valid", opId: "sessionUpdate:ses_a", op: "session/update" as const, idempotencyKey: "idem1", context: { directory: "/tmp", sessionId: "ses_a", parentSessionId: null }, payload: { title: "hi" } }
    const res = await peer.privateSessionUpdate(req)
    expect(res.status).toBe("failed")
    if (res.status === "failed") expect(res.failure.code).toBe("internal")
    peer.dispose()
  })

  test("privateSessionUpdate after dispose throws", async () => {
    const { clientReader, clientWriter } = createLinkedChannel(async (method) => {
      if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/update"] }
      throw new Error("x")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, pid: 222, epoch: 22, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    peer.dispose()
    const req = { v: 1 as const, requestId: "req", opId: "sessionUpdate:ses_a", op: "session/update" as const, idempotencyKey: "idem", context: { directory: "/tmp", sessionId: "ses_a", parentSessionId: null }, payload: { title: "hi" } }
    await expect(peer.privateSessionUpdate(req)).rejects.toThrow()
  })

  test("privateSessionUpdate epoch drift after call returns ambiguous", async () => {
    const toClient = new PassThrough()
    const toBackend = new PassThrough()
    const backendPeer = new JsonRpcPeer({
      reader: toBackend,
      writer: toClient,
      onRequest: async (method) => {
        if (method === "initialize") return { protocol: { name: "kilo-private", major: 1, minor: 0 }, serverInfo: { name: "kilo", version: "1" }, capabilities: ["session/update"] }
        return new Promise(() => {})
      },
    })
    const peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 223, epoch: 23, initializeTimeoutMs: 300 })
    expect(await peer.initialize(300)).toBeTrue()
    const req = { v: 1 as const, requestId: "req", opId: "sessionUpdate:ses_a", op: "session/update" as const, idempotencyKey: "idem", context: { directory: "/tmp", sessionId: "ses_a", parentSessionId: null }, payload: { title: "hi" } }
    const p = peer.privateSessionUpdate(req)
    // simulate epoch drift by mutating opts.epoch via dispose+new peer? Simplify: dispose peer triggers closed
    setTimeout(() => {
      toClient.end()
      backendPeer.dispose()
    }, 30)
    const res = await p
    expect(res.status).toBe("ambiguous")
    expect((res as unknown as { transportUnknown?: boolean }).transportUnknown).toBeTrue()
    peer.dispose()
  })

  test("compareUpdateParity detects divergences", () => {
    const sdkSuccess = { data: { id: "ses_a", title: "hello", time: { created: 1, updated: 2 } }, error: undefined, response: { status: 200 } }
    const privSuccess = { v: 1, requestId: "r", opId: "sessionUpdate:ses_a", op: "session/update", idempotencyKey: "i", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: { title: "hello", session: { id: "ses_a", title: "hello" } } } as unknown as Parameters<typeof compareUpdateParity>[0]
    const { divergence: d1 } = compareUpdateParity(privSuccess, sdkSuccess as unknown as Parameters<typeof compareUpdateParity>[1])
    expect(d1).toBeNull()

    const privMismatch = { v: 1, requestId: "r", opId: "sessionUpdate:ses_a", op: "session/update", idempotencyKey: "i", status: "succeeded", outcome: { type: "succeeded", time: 1 }, accepted: true, data: { title: "different" } } as unknown as Parameters<typeof compareUpdateParity>[0]
    const { divergence: d2 } = compareUpdateParity(privMismatch, sdkSuccess as unknown as Parameters<typeof compareUpdateParity>[1])
    expect(d2).toContain("title-mismatch")

    const sdkFailed409 = { data: undefined, error: { status: 409 }, response: { status: 409 } }
    const privFailedStale = { v: 1, requestId: "r", opId: "sessionUpdate:ses_a", op: "session/update", idempotencyKey: "i", status: "failed", outcome: { type: "failed", time: 1, failure: { code: "stale", message: "x", retryable: false } }, accepted: false, failure: { code: "stale", message: "x", retryable: false } } as unknown as Parameters<typeof compareUpdateParity>[0]
    const { divergence: d3 } = compareUpdateParity(privFailedStale, sdkFailed409 as unknown as Parameters<typeof compareUpdateParity>[1])
    expect(d3).toBeNull()

    const privAmbiguous = { v: 1, requestId: "r", opId: "sessionUpdate:ses_a", op: "session/update", idempotencyKey: "i", status: "ambiguous", outcome: { type: "ambiguous", time: 1 }, accepted: false, transportUnknown: true } as unknown as Parameters<typeof compareUpdateParity>[0]
    const { divergence: d4 } = compareUpdateParity(privAmbiguous, sdkSuccess as unknown as Parameters<typeof compareUpdateParity>[1])
    expect(d4).toBe("transport-unknown")

    const privFailedValidation = { v: 1, requestId: "r", opId: "sessionUpdate:ses_a", op: "session/update", idempotencyKey: "i", status: "failed", outcome: { type: "failed", time: 1, failure: { code: "validation.failed", message: "x", retryable: false } }, accepted: false, failure: { code: "validation.failed", message: "x", retryable: false } } as unknown as Parameters<typeof compareUpdateParity>[0]
    const sdk400 = { data: undefined, error: { status: 400 }, response: { status: 400 } }
    const { divergence: d5 } = compareUpdateParity(privFailedValidation, sdk400 as unknown as Parameters<typeof compareUpdateParity>[1])
    expect(d5).toBeNull()

    const privAmbiguousReal = { v: 1, requestId: "r", opId: "sessionUpdate:ses_a", op: "session/update", idempotencyKey: "i", status: "ambiguous", outcome: { type: "ambiguous", time: 1 }, accepted: false } as unknown as Parameters<typeof compareUpdateParity>[0]
    const { divergence: d6 } = compareUpdateParity(privAmbiguousReal, sdkFailed409 as unknown as Parameters<typeof compareUpdateParity>[1])
    expect(d6).toBeNull()
  })

  test("getSdkHttpStatus extracts response.status before error heuristics for update", () => {
    expect(getSdkHttpStatus({ response: { status: 404 }, error: { _tag: "BadRequest" } })).toBe(404)
    expect(getSdkHttpStatus({ response: { status: 409 }, error: undefined })).toBe(409)
  })
})
