import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import { canonicalRemoteDisableOpId, canonicalRemoteEnableOpId } from "./serve-private-remote-toggle-contract"

function channel(handler: (method: string, params: unknown) => unknown | Promise<unknown>) {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const backend = new JsonRpcPeer({ reader: toBackend, writer: toClient, onRequest: handler as never })
  return { clientReader: toClient, clientWriter: toBackend, backend }
}

function enableReq(token = "tok1") {
  const opId = canonicalRemoteEnableOpId(token)
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "remote/enable" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
  }
}

function disableReq(token = "tok1") {
  const opId = canonicalRemoteDisableOpId(token)
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "remote/disable" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
  }
}

function okResult(req: ReturnType<typeof enableReq> | ReturnType<typeof disableReq>, enabled: boolean) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { status: { enabled, connected: false } },
  }
}

async function peerFor(caps: string[], handler: (method: string, params: unknown) => unknown) {
  const toClient = new PassThrough()
  const toBackend = new PassThrough()
  const backend = new JsonRpcPeer({ reader: toBackend, writer: toClient, onRequest: handler as never })
  const client = new JsonRpcPeer({ reader: toClient, writer: toBackend })
  const peer = new ServePrivatePeer({ reader: toClient, writer: toBackend, epoch: 1 })
  ;(peer as unknown as { capabilities: unknown }).capabilities = caps
  ;(peer as unknown as { available: boolean }).available = true
  ;(peer as unknown as { peer: unknown }).peer = client
  return { peer, backend, client }
}

describe("remote-toggle private peer", () => {
  test("capability gating is per-action and fail-closed", async () => {
    const { peer, backend, client } = await peerFor(["remote/enable"], async () => okResult(enableReq(), true))
    expect(peer.hasCapability("remote/enable")).toBeTrue()
    expect(peer.hasCapability("remote/disable")).toBeFalse()
    expect(() => peer.privateRemoteToggleOutcomeWithHandle(enableReq() as never)).not.toThrow()
    expect(() => peer.privateRemoteToggleOutcomeWithHandle(disableReq() as never)).toThrow(
      "Private peer missing remote/disable capability",
    )
    peer.dispose()
    client.dispose()
    backend.dispose()
  })

  test("read and write results stay distinct types (op binding)", async () => {
    const { peer, backend, client } = await peerFor(
      ["remote/enable", "remote/disable"],
      async (method: string, params: unknown) => {
        const req = params as { op: string; requestId: string; opId: string; idempotencyKey: string }
        return okResult(req as never, req.op === "remote/enable")
      },
    )
    const en = await peer.privateRemoteToggleWithHandle(enableReq("e1") as never).promise
    expect(en.op).toBe("remote/enable")
    if (en.status === "succeeded") expect(en.data.status.enabled).toBeTrue()
    const dis = await peer.privateRemoteToggleWithHandle(disableReq("d1") as never).promise
    expect(dis.op).toBe("remote/disable")
    if (dis.status === "succeeded") expect(dis.data.status.enabled).toBeFalse()
    peer.dispose()
    client.dispose()
    backend.dispose()
  })
})
