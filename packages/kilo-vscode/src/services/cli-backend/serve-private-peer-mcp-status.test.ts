import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import { canonicalMcpStatusOpId, validateMcpStatusResult } from "./serve-private-mcp-status-contract"

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

function makeReq(over: Record<string, unknown> = {}) {
  const opId = canonicalMcpStatusOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "mcp/status" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
    ...over,
  }
}

function makeSuccess(req: ReturnType<typeof makeReq>, status: unknown = { docs: { status: "connected" } }) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/status",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { status },
  }
}

function install(peer: ServePrivatePeer, caps: string[], reader: PassThrough, writer: PassThrough) {
  ;(peer as unknown as Record<string, unknown>).available = true
  ;(peer as unknown as Record<string, unknown>).peer = new JsonRpcPeer({ reader, writer })
  ;(peer as unknown as Record<string, unknown>).capabilities = caps
}

describe("mcp-status private peer", () => {
  test("capability gating requires mcp/status", () => {
    const { clientReader, clientWriter, backendPeer } = channel(() => ({ v: 1 }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 1 })
    install(peer, ["session/get"], clientReader, clientWriter)
    const req = makeReq()
    expect(() => peer.privateMcpStatusOutcomeWithHandle(req as never)).toThrow(
      "Private peer missing mcp/status capability",
    )
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("unavailable/disposed fails closed", () => {
    const { clientReader, clientWriter, backendPeer } = channel(() => ({ v: 1 }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 1 })
    const req = makeReq()
    expect(() => peer.privateMcpStatusOutcomeWithHandle(req as never)).toThrow("Private peer unavailable")
    peer.dispose()
    expect(() => peer.privateMcpStatusOutcomeWithHandle(req as never)).toThrow()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("outcome handle resolves normalized wire over the mcp/status method", async () => {
    const req = makeReq()
    const success = makeSuccess(req)
    const seen: string[] = []
    const { clientReader, clientWriter, backendPeer } = channel((method) => {
      seen.push(method)
      return success
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    install(peer, ["mcp/status"], clientReader, clientWriter)
    const outcome = await peer.privateMcpStatusOutcomeWithHandle(req as never).promise
    expect(seen).toEqual(["mcp/status"])
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") {
      expect(outcome.result.status).toBe("succeeded")
      expect(() => validateMcpStatusResult(outcome.result as unknown, req as never)).not.toThrow()
    }
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("invalid wire resolves as invalid before any comparator", async () => {
    const req = makeReq()
    const bad = { ...makeSuccess(req), data: { status: { a: { status: "restarting" } } } }
    const { clientReader, clientWriter, backendPeer } = channel(() => bad)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    install(peer, ["mcp/status"], clientReader, clientWriter)
    const outcome = await peer.privateMcpStatusOutcomeWithHandle(req as never).promise
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind !== "invalid") throw new Error("expected invalid wire outcome")
    expect(outcome.detail.length).toBeGreaterThan(0)
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })

  test("exact cancel owns the allocated id", async () => {
    const req = makeReq()
    let release: ((v: unknown) => void) | null = null
    const gate = new Promise<unknown>((resolve) => {
      release = resolve
    })
    const { clientReader, clientWriter, backendPeer } = channel(() => gate)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    install(peer, ["mcp/status"], clientReader, clientWriter)
    const handle = peer.privateMcpStatusOutcomeWithHandle(req as never)
    expect(typeof handle.id).toBe("number")
    expect(peer.getPendingCount()).toBe(1)
    expect(handle.cancel()).toBeTrue()
    release!({ kind: "valid", result: makeSuccess(req) })
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    peer.dispose()
    backendPeer.dispose()
    clientReader.destroy()
    clientWriter.destroy()
  })
})
