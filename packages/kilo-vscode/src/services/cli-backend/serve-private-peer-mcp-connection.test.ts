import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import {
  canonicalMcpAuthenticateOpId,
  canonicalMcpConnectOpId,
  canonicalMcpDisconnectOpId,
  validateMcpAuthenticateResult,
  validateMcpConnectResult,
  validateMcpDisconnectResult,
} from "./serve-private-mcp-connection-contract"

function channel(handler: (method: string, params: unknown) => unknown | Promise<unknown>) {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const backendPeer = new JsonRpcPeer({
    reader: toBackend,
    writer: toClient,
    onRequest: handler as unknown as (m: string, p: unknown) => unknown,
  })
  return { clientReader: toClient, clientWriter: toBackend, backendPeer }
}

function connectReq(over: Record<string, unknown> = {}) {
  const opId = canonicalMcpConnectOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "mcp/connect" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: { name: "demo" },
    ...over,
  }
}

function disconnectReq(over: Record<string, unknown> = {}) {
  const opId = canonicalMcpDisconnectOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "mcp/disconnect" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: { name: "demo" },
    ...over,
  }
}

function connectSuccess(req: ReturnType<typeof connectReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/connect",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { connected: true },
  }
}

function disconnectSuccess(req: ReturnType<typeof disconnectReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/disconnect",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { disconnected: true },
  }
}

function authenticateReq(over: Record<string, unknown> = {}) {
  const opId = canonicalMcpAuthenticateOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "mcp/authenticate" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: { name: "demo" },
    ...over,
  }
}

function authenticateSuccess(req: ReturnType<typeof authenticateReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/authenticate",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { authenticated: true },
  }
}

function install(peer: ServePrivatePeer, caps: string[], reader: PassThrough, writer: PassThrough) {
  ;(peer as unknown as Record<string, unknown>).available = true
  ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader, writer })
  ;(peer as unknown as Record<string, unknown>).capabilities = caps
}

function closeAll(peers: { dispose(): void }[], streams: PassThrough[]) {
  for (const p of peers) p.dispose()
  for (const s of streams) s.destroy()
}

describe("mcp-connect/mcp-disconnect/mcp-authenticate private peer", () => {
  test("capability gating requires the exact per-op capability", () => {
    const { clientReader, clientWriter, backendPeer } = channel(() => ({ v: 1 }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 1 })
    install(peer, ["mcp/status"], clientReader, clientWriter)
    expect(() => peer.privateMcpConnectOutcomeWithHandle(connectReq() as never)).toThrow(
      "Private peer missing mcp/connect capability",
    )
    expect(() => peer.privateMcpDisconnectOutcomeWithHandle(disconnectReq() as never)).toThrow(
      "Private peer missing mcp/disconnect capability",
    )
    expect(() => peer.privateMcpAuthenticateOutcomeWithHandle(authenticateReq() as never)).toThrow(
      "Private peer missing mcp/authenticate capability",
    )
    closeAll([peer, backendPeer], [clientReader, clientWriter])
  })

  test("unavailable/disposed fails closed on both ops", () => {
    const { clientReader, clientWriter, backendPeer } = channel(() => ({ v: 1 }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 1 })
    expect(() => peer.privateMcpConnectOutcomeWithHandle(connectReq() as never)).toThrow("Private peer unavailable")
    expect(() => peer.privateMcpDisconnectOutcomeWithHandle(disconnectReq() as never)).toThrow(
      "Private peer unavailable",
    )
    peer.dispose()
    expect(() => peer.privateMcpConnectOutcomeWithHandle(connectReq() as never)).toThrow()
    closeAll([peer, backendPeer], [clientReader, clientWriter])
  })

  test("each outcome handle resolves normalized wire over its own method exactly once", async () => {
    const creq = connectReq()
    const dreq = disconnectReq()
    const seen: string[] = []
    const { clientReader, clientWriter, backendPeer } = channel((method, params) => {
      seen.push(method)
      const p = params as { op?: string }
      return p.op === "mcp/connect" ? connectSuccess(creq) : disconnectSuccess(dreq)
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    install(peer, ["mcp/connect", "mcp/disconnect"], clientReader, clientWriter)
    const coutcome = await peer.privateMcpConnectOutcomeWithHandle(creq as never).promise
    expect(coutcome.kind).toBe("valid")
    if (coutcome.kind === "valid") {
      expect(coutcome.result.status).toBe("succeeded")
      expect(() => validateMcpConnectResult(coutcome.result as unknown, creq as never)).not.toThrow()
    }
    const doutcome = await peer.privateMcpDisconnectOutcomeWithHandle(dreq as never).promise
    expect(doutcome.kind).toBe("valid")
    if (doutcome.kind === "valid") {
      expect(doutcome.result.status).toBe("succeeded")
      expect(() => validateMcpDisconnectResult(doutcome.result as unknown, dreq as never)).not.toThrow()
    }
    expect(seen).toEqual(["mcp/connect", "mcp/disconnect"])
    closeAll([peer, backendPeer], [clientReader, clientWriter])
  })

  test("authenticate outcome handle resolves normalized wire over its own method exactly once", async () => {
    const areq = authenticateReq()
    const { clientReader, clientWriter, backendPeer } = channel((method) => {
      expect(method).toBe("mcp/authenticate")
      return authenticateSuccess(areq)
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    install(peer, ["mcp/authenticate"], clientReader, clientWriter)
    const outcome = await peer.privateMcpAuthenticateOutcomeWithHandle(areq as never).promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") {
      expect(outcome.result.status).toBe("succeeded")
      expect(() => validateMcpAuthenticateResult(outcome.result as unknown, areq as never)).not.toThrow()
    }
    closeAll([peer, backendPeer], [clientReader, clientWriter])
  })

  test("transport failure maps to ambiguous with no SDK involvement", async () => {
    const creq = connectReq()
    const { clientReader, clientWriter, backendPeer } = channel(() => {
      throw new Error("boom")
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    install(peer, ["mcp/connect"], clientReader, clientWriter)
    const outcome = await peer.privateMcpConnectOutcomeWithHandle(creq as never).promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind !== "valid") throw new Error("expected valid ambiguous outcome")
    expect(outcome.result.status).toBe("ambiguous")
    closeAll([peer, backendPeer], [clientReader, clientWriter])
  })

  test("invalid wire resolves as invalid before any refresh decision", async () => {
    const dreq = disconnectReq()
    const bad = { ...disconnectSuccess(dreq), data: { disconnected: false } }
    const { clientReader, clientWriter, backendPeer } = channel(() => bad)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    install(peer, ["mcp/disconnect"], clientReader, clientWriter)
    const outcome = await peer.privateMcpDisconnectOutcomeWithHandle(dreq as never).promise
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind !== "invalid") throw new Error("expected invalid wire outcome")
    expect(outcome.detail.length).toBeGreaterThan(0)
    closeAll([peer, backendPeer], [clientReader, clientWriter])
  })

  test("exact cancel owns the allocated id", async () => {
    const creq = connectReq()
    let release: ((v: unknown) => void) | null = null
    const gate = new Promise<unknown>((resolve) => {
      release = resolve
    })
    const { clientReader, clientWriter, backendPeer } = channel(() => gate)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    install(peer, ["mcp/connect"], clientReader, clientWriter)
    const handle = peer.privateMcpConnectOutcomeWithHandle(creq as never)
    expect(typeof handle.id).toBe("number")
    expect(peer.getPendingCount()).toBe(1)
    expect(handle.cancel()).toBeTrue()
    release!(connectSuccess(creq))
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    closeAll([peer, backendPeer], [clientReader, clientWriter])
  })
})
