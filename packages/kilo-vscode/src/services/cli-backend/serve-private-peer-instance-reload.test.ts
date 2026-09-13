import { describe, expect, test } from "bun:test"
import { PassThrough } from "stream"
import { JsonRpcPeer } from "../../private-worker/peer"
import { ServePrivatePeer } from "./serve-private-peer"
import { canonicalInstanceReloadOpId } from "./serve-private-instance-reload-contract"

function reloadReq(token = "tok1") {
  const opId = canonicalInstanceReloadOpId(token)
  return {
    v: 1 as const,
    requestId: "r1",
    opId,
    op: "instance/reload" as const,
    idempotencyKey: opId,
    context: { directory: "/tmp" },
    payload: {},
  }
}

function okResult(req: ReturnType<typeof reloadReq>) {
  return {
    v: 1,
    requestId: req.requestId,
    opId: req.opId,
    op: req.op,
    idempotencyKey: req.idempotencyKey,
    status: "succeeded",
    outcome: { type: "succeeded", time: 1 },
    accepted: true,
    data: { reloaded: true },
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

describe("instance-reload private peer", () => {
  test("capability gating is fail-closed", async () => {
    const { peer, backend, client } = await peerFor(["session/status"], async () => okResult(reloadReq()))
    expect(peer.hasCapability("instance/reload")).toBeFalse()
    expect(() => peer.privateInstanceReloadOutcomeWithHandle(reloadReq() as never)).toThrow(
      "Private peer missing instance/reload capability",
    )
    peer.dispose()
    client.dispose()
    backend.dispose()
  })

  test("instance/reload success resolves strictly valid result with canonical identity", async () => {
    const { peer, backend, client } = await peerFor(["instance/reload"], async (method: string, params: unknown) => {
      expect(method).toBe("instance/reload")
      const p = params as { context: { directory: string } }
      expect(p.context.directory).toBe("/tmp")
      return okResult(params as never)
    })
    const out = await peer.privateInstanceReloadWithHandle(reloadReq("peer-ok") as never).promise
    expect(out.op).toBe("instance/reload")
    expect(out.status).toBe("succeeded")
    if (out.status === "succeeded") expect(out.data).toEqual({ reloaded: true })
    peer.dispose()
    client.dispose()
    backend.dispose()
  })

  test("invalid wire rejects with the instance-reload validation error", async () => {
    const { peer, backend, client } = await peerFor(["instance/reload"], async () => ({ garbled: true }))
    await expect(peer.privateInstanceReloadWithHandle(reloadReq("peer-bad") as never).promise).rejects.toThrow(
      "invalid private response shape",
    )
    peer.dispose()
    client.dispose()
    backend.dispose()
  })
})
