import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import { canonicalMcpAddOpId, validateMcpAddResult } from "./serve-private-mcp-add-contract"

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

function addReq(over: Record<string, unknown> = {}) {
  const opId = canonicalMcpAddOpId("tok1")
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "mcp/add" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {
      name: "kilo-playwright",
      config: { type: "local", command: ["npx", "@playwright/mcp@latest"], enabled: true, timeout: 60000 },
    },
    ...over,
  }
}

function addSuccess(req: ReturnType<typeof addReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: "mcp/add",
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { status: { "kilo-playwright": { status: "connected" } } },
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

describe("mcp-add private peer", () => {
  test("capability gating requires the exact mcp/add capability", () => {
    const { clientReader, clientWriter, backendPeer } = channel(() => ({ v: 1 }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 1 })
    install(peer, ["mcp/status"], clientReader, clientWriter)
    expect(() => peer.privateMcpAddOutcomeWithHandle(addReq() as never)).toThrow(
      "Private peer missing mcp/add capability",
    )
    closeAll([peer, backendPeer], [clientReader, clientWriter])
  })

  test("unavailable/disposed fails closed", () => {
    const { clientReader, clientWriter, backendPeer } = channel(() => ({ v: 1 }))
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 1 })
    expect(() => peer.privateMcpAddOutcomeWithHandle(addReq() as never)).toThrow("Private peer unavailable")
    peer.dispose()
    expect(() => peer.privateMcpAddOutcomeWithHandle(addReq() as never)).toThrow()
    closeAll([peer, backendPeer], [clientReader, clientWriter])
  })

  test("add outcome handle resolves normalized wire over mcp/add exactly once", async () => {
    const areq = addReq()
    const { clientReader, clientWriter, backendPeer } = channel((method) => {
      expect(method).toBe("mcp/add")
      return addSuccess(areq)
    })
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    install(peer, ["mcp/add"], clientReader, clientWriter)
    const outcome = await peer.privateMcpAddOutcomeWithHandle(areq as never).promise
    expect(outcome.kind).toBe("valid")
    if (outcome.kind === "valid") {
      expect(outcome.result.status).toBe("succeeded")
      expect(() => validateMcpAddResult(outcome.result as unknown, areq as never)).not.toThrow()
    }
    closeAll([peer, backendPeer], [clientReader, clientWriter])
  })

  test("invalid wire resolves as invalid before any refresh decision", async () => {
    const areq = addReq()
    const bad = { ...addSuccess(areq), data: { status: { "kilo-playwright": { status: "bogus" } } } }
    const { clientReader, clientWriter, backendPeer } = channel(() => bad)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    install(peer, ["mcp/add"], clientReader, clientWriter)
    const outcome = await peer.privateMcpAddOutcomeWithHandle(areq as never).promise
    expect(outcome.kind).toBe("invalid")
    if (outcome.kind !== "invalid") throw new Error("expected invalid wire outcome")
    expect(outcome.detail.length).toBeGreaterThan(0)
    closeAll([peer, backendPeer], [clientReader, clientWriter])
  })

  test("exact cancel owns the allocated id", async () => {
    const areq = addReq()
    let release: ((v: unknown) => void) | null = null
    const gate = new Promise<unknown>((resolve) => {
      release = resolve
    })
    const { clientReader, clientWriter, backendPeer } = channel(() => gate)
    const peer = new ServePrivatePeer({ reader: clientReader, writer: clientWriter, epoch: 5 })
    install(peer, ["mcp/add"], clientReader, clientWriter)
    const handle = peer.privateMcpAddOutcomeWithHandle(areq as never)
    expect(typeof handle.id).toBe("number")
    expect(peer.getPendingCount()).toBe(1)
    expect(handle.cancel()).toBeTrue()
    release!(addSuccess(areq))
    const outcome = await handle.promise
    expect(outcome.kind).toBe("valid")
    closeAll([peer, backendPeer], [clientReader, clientWriter])
  })
})
