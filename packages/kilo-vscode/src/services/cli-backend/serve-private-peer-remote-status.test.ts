import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import {
  ServePrivatePeer,
  canonicalRemoteStatusOpId,
  compareRemoteStatusParity,
  normalizePrivateRemoteStatusWire,
  validateRemoteStatusRequest,
  validateRemoteStatusResult,
} from "./serve-private-peer"
import { buildRemoteStatusIdentity } from "../../kilo-provider/remote-status-privatefirst"

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

function makeReq(over: Record<string, unknown> = {}) {
  const opId = canonicalRemoteStatusOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "remote/status" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
    ...over,
  }
}

function makeSuccess(req: ReturnType<typeof makeReq>, enabled = true, connected = false) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "remote/status",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { status: { enabled, connected } },
  }
}

function makeFailed(req: ReturnType<typeof makeReq>, code: string) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "remote/status",
    idempotencyKey: req.idempotencyKey,
    status: "failed",
    outcome: { type: "failed", time: 1, failure: { code, message: "x", retryable: false } },
    accepted: false,
    failure: { code, message: "x", retryable: false },
  }
}

describe("remote/status private peer (process-global parity)", () => {
  test("canonical opId binds single colon-free token with idempotency equality", () => {
    expect(canonicalRemoteStatusOpId("t1")).toBe("remote-status:t1")
    expect(() => canonicalRemoteStatusOpId("")).toThrow()
    expect(() => canonicalRemoteStatusOpId("a:b")).toThrow()
    const ident = buildRemoteStatusIdentity()
    expect(ident.opId.startsWith("remote-status:")).toBeTrue()
    expect(ident.idempotencyKey).toBe(ident.opId)
  })

  test("validateRemoteStatusRequest accepts strict shape and rejects violations", () => {
    const req = makeReq()
    expect(() => validateRemoteStatusRequest(req)).not.toThrow()
    expect(() => validateRemoteStatusRequest({ ...req, v: 2 })).toThrow()
    expect(() => validateRemoteStatusRequest({ ...req, op: "session/get" })).toThrow()
    expect(() => validateRemoteStatusRequest({ ...req, idempotencyKey: canonicalRemoteStatusOpId("other") })).toThrow()
    expect(() => validateRemoteStatusRequest({ ...req, context: { directory: "relative" } })).toThrow()
    expect(() => validateRemoteStatusRequest({ ...req, payload: { reason: "x" } })).toThrow()
    expect(() => validateRemoteStatusRequest({ ...req, extra: 1 })).toThrow()
    expect(() => validateRemoteStatusRequest({ ...req, opId: "bad", idempotencyKey: "bad" })).toThrow()
    const ws = makeReq({ context: { directory: "/tmp", workspace: "ws1" } })
    expect(() => validateRemoteStatusRequest(ws)).not.toThrow()
    expect(() => validateRemoteStatusRequest({ ...req, context: { directory: "/tmp", workspace: "" } })).toThrow()
  })

  test("validateRemoteStatusResult enforces identity and process-global shape without directory binding", () => {
    const req = makeReq()
    expect(() => validateRemoteStatusResult(makeSuccess(req), req)).not.toThrow()
    expect(() => validateRemoteStatusResult(makeFailed(req, "validation.failed"), req)).not.toThrow()
    // Identical process-global payload under a different request directory is still shape-valid.
    const other = makeReq({ requestId: "r2", context: { directory: "/other" } })
    const samePayload = { ...makeSuccess(other), data: (makeSuccess(req) as { data: unknown }).data }
    expect(() => validateRemoteStatusResult(samePayload, other)).not.toThrow()
    expect(() => validateRemoteStatusResult({ ...makeSuccess(req), requestId: "r2" }, req)).toThrow()
    expect(() =>
      validateRemoteStatusResult({ ...makeSuccess(req), data: { status: { enabled: true } } }, req),
    ).toThrow()
  })

  // `compareRemoteStatusParity` stays as pure diagnostic/test evidence only:
  // production private-first issues at most one private plus at most one
  // SDK read per user action, never a third comparison request.
  test("compareRemoteStatusParity compares only booleans; cross-directory equality is not a divergence", () => {
    const req = makeReq()
    const ok = validateRemoteStatusResult(makeSuccess(req, true, false), req)
    expect(compareRemoteStatusParity(ok, { data: { enabled: true, connected: false } }).divergence).toBeNull()
    const details = compareRemoteStatusParity(ok, { data: { enabled: true, connected: false } }).details
    expect(details.processGlobal).toBeTrue()
    expect(details.globalExcluded).toBeTrue()
    expect(compareRemoteStatusParity(ok, { data: { enabled: false, connected: false } }).divergence).toBe(
      "remote-status-enabled-mismatch",
    )
    expect(compareRemoteStatusParity(ok, { data: { enabled: true, connected: true } }).divergence).toBe(
      "remote-status-connected-mismatch",
    )
    expect(compareRemoteStatusParity(ok, { error: { message: "boom" } }).divergence).toContain("status-mismatch")
    const text = JSON.stringify(compareRemoteStatusParity(ok, { data: { enabled: false, connected: false } }))
    expect(text.includes("/tmp")).toBeFalse()
    expect(text.includes("tok1")).toBeFalse()
    expect(text.includes("remote-status:")).toBeFalse()
  })

  test("privateRemoteStatus success resolves strictly valid result", async () => {
    const req = makeReq()
    const {
      clientReader: toClient,
      clientWriter: toBackend,
      backendPeer,
    } = createLinkedChannel((method, params) => {
      if (method === "initialize") {
        return {
          protocol: { name: "kilo-private", major: 1, minor: 0 },
          protocolVersion: "1.0",
          serverInfo: { name: "kilo", version: "7.4.11" },
          capabilities: ["remote/status"],
        }
      }
      if (method === "remote/status") return makeSuccess(params as ReturnType<typeof makeReq>)
      throw new Error(`unexpected ${method}`)
    })
    let peer: ServePrivatePeer | undefined
    try {
      peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 11, epoch: 1, initializeTimeoutMs: 500 })
      expect(await peer.initialize(500)).toBeTrue()
      expect(peer.hasCapability("remote/status")).toBeTrue()
      const res = await peer.privateRemoteStatus(req as never)
      expect(res.status).toBe("succeeded")
      if (res.status === "succeeded") {
        expect(res.data.status).toEqual({ enabled: true, connected: false })
      }
    } finally {
      peer?.dispose()
      backendPeer.dispose()
    }
  })

  test("privateRemoteStatusOutcomeWithHandle surfaces invalid wire without entering comparator", async () => {
    const req = makeReq()
    const {
      clientReader: toClient,
      clientWriter: toBackend,
      backendPeer,
    } = createLinkedChannel((method) => {
      if (method === "initialize") {
        return {
          protocol: { name: "kilo-private", major: 1, minor: 0 },
          protocolVersion: "1.0",
          serverInfo: { name: "kilo", version: "7.4.11" },
          capabilities: ["remote/status"],
        }
      }
      return { bogus: true }
    })
    let peer: ServePrivatePeer | undefined
    try {
      peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, pid: 12, epoch: 2, initializeTimeoutMs: 500 })
      expect(await peer.initialize(500)).toBeTrue()
      const outcome = await peer.privateRemoteStatusOutcomeWithHandle(req as never).promise
      expect(outcome.kind).toBe("invalid")
      const wire = normalizePrivateRemoteStatusWire({ bogus: true }, req as never)
      expect(wire.kind).toBe("invalid")
    } finally {
      peer?.dispose()
      backendPeer.dispose()
    }
  })

  test("missing capability and dispose fail closed; stale epoch maps to ambiguous transportUnknown", async () => {
    const req = makeReq()
    const ch = createLinkedChannel((method, params) => {
      if (method === "initialize") {
        return {
          protocol: { name: "kilo-private", major: 1, minor: 0 },
          protocolVersion: "1.0",
          serverInfo: { name: "kilo", version: "7.4.11" },
          capabilities: ["session/status"],
        }
      }
      if (method === "remote/status") return makeSuccess(params as ReturnType<typeof makeReq>)
      throw new Error(`unexpected ${method}`)
    })
    let peer: ServePrivatePeer | undefined
    try {
      peer = new ServePrivatePeer({
        reader: ch.clientReader,
        writer: ch.clientWriter,
        pid: 13,
        epoch: 3,
        initializeTimeoutMs: 500,
      })
      expect(await peer.initialize(500)).toBeTrue()
      expect(peer.hasCapability("remote/status")).toBeFalse()
      let threw = ""
      try {
        await peer.privateRemoteStatus(req as never)
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e)
      }
      expect(threw).toContain("remote/status capability")
      peer.dispose()
      expect(peer.isAvailable()).toBeFalse()
      let threw2 = ""
      try {
        peer.privateRemoteStatusOutcomeWithHandle(req as never)
      } catch (e) {
        threw2 = e instanceof Error ? e.message : String(e)
      }
      expect(threw2.length).toBeGreaterThan(0)
    } finally {
      peer?.dispose()
      ch.backendPeer.dispose()
    }
  })
})
